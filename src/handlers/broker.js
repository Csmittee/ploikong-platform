// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG API — Broker Vetting System
//  File: src/handlers/broker.js
//  Lane: D
//
//  ROUTES (all require Staff JWT — authenticateStaffJWT in index.js):
//
//  BROKER APPLICATIONS (pipeline):
//    POST /v1/admin/brokers                      — submit application (member self)
//    GET  /v1/admin/brokers                      — list all applications (staff)
//    GET  /v1/admin/brokers/:id                  — single application detail (staff)
//    POST /v1/admin/brokers/:id/advance          — move to next phase (ops_manager|owner)
//    POST /v1/admin/brokers/:id/approve          — grant broker status (ops_manager|owner)
//    POST /v1/admin/brokers/:id/reject           — reject application (ops_manager|owner)
//    POST /v1/admin/brokers/:id/suspend          — suspend active broker (ops_manager|owner)
//    POST /v1/admin/brokers/:id/reinstate        — lift suspension (owner only)
//
//  DOCUMENTS:
//    POST /v1/admin/brokers/:id/documents        — attach document record (staff)
//    GET  /v1/admin/brokers/:id/documents        — list documents (staff)
//
//  COMPLIANCE:
//    GET  /v1/admin/brokers/:id/compliance       — compliance check history (staff)
//    POST /v1/admin/brokers/:id/compliance       — manual spot check (compliance_auditor|owner)
//    POST /v1/admin/brokers/:id/compliance/:checkId/result — record check result (staff)
//
//  FLAGS:
//    GET  /v1/admin/brokers/:id/flags            — broker's flag history (staff)
//    POST /v1/admin/brokers/:id/flag             — raise a flag (staff)
//    POST /v1/admin/brokers/flags/:flagId/resolve — resolve a flag (ops_manager|owner)
//
//  PAYMENT VIOLATION REPORTS (member-submitted):
//    POST /v1/brokers/report                     — buyer reports payment bypass (member JWT)
//    GET  /v1/admin/brokers/reports              — list reports (ops_manager|owner)
//    POST /v1/admin/brokers/reports/:id/resolve  — resolve report (ops_manager|owner)
//
//  KEY RULES:
//    L061 — all rates/limits from platform_config (max_broker_count, compliance_check_days)
//    L062 — staff JWT is completely separate from member JWT
//    L063 — payment firewall is hardcoded — broker never touches money
//    L064 — requireConsent() on member-submitted routes
//    L065 — broker code format: PKB-FIRSTNAME (unique, human-readable)
//    L066 — compliance reports always notify owner + legal_officer (Option C)
//    L067 — never send email inline — always queue to notification_queue
//    L075 — public GET routes above the JWT call in index.js
//    L079 — exact routes before regex routes
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() {
    return Math.floor(Date.now() / 1000);
}

async function getPlatformConfig(env) {
    const rows = await env.DB.prepare(
        'SELECT key, value FROM platform_config'
    ).all();
    return Object.fromEntries((rows.results ?? []).map(r => [r.key, r.value]));
}

async function queueNotification(env, toEmail, template, payload, memberId = null, staffId = null) {
    await env.DB.prepare(`
        INSERT INTO notification_queue
            (member_id, staff_id, to_email, template, payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?)
    `).bind(memberId, staffId, toEmail, template, JSON.stringify(payload), now()).run();
}

// Notify owner + current legal_officer — used for every compliance event (L066)
async function notifyOwnerAndLegal(env, template, payload) {
    await queueNotification(env, 'csmittee@gmail.com', template, payload);

    const legal = await env.DB.prepare(
        "SELECT email FROM staff WHERE role='legal_officer' AND status='active' LIMIT 1"
    ).first();
    if (legal?.email) {
        await queueNotification(env, legal.email, template, payload);
    }
}

// Check pending_consent before transactional routes (L064)
async function requireConsent(memberId, env) {
    const member = await env.DB.prepare(
        'SELECT pending_consent FROM members WHERE id = ?'
    ).bind(memberId).first();
    if (member?.pending_consent === 1) {
        return Response.json({
            error:    'consent_required',
            message:  'Please review and sign the updated Terms of Service to continue.',
            redirect: '/consent'
        }, { status: 403 });
    }
    return null;
}

// Generate a unique broker code — PKB-FIRSTNAME, collision-safe (L065)
async function generateBrokerCode(env, fullName) {
    const firstName = fullName.trim().split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '');
    const base      = `PKB-${firstName}`;

    const existing = await env.DB.prepare(
        "SELECT broker_code FROM members WHERE broker_code LIKE ? ORDER BY broker_code"
    ).bind(`${base}%`).all();

    if (!existing.results?.length) return base;

    // Append suffix number if collision
    const suffixes = existing.results.map(r => {
        const parts = r.broker_code.split('-');
        return parts.length === 3 ? parseInt(parts[2]) : 1;
    });
    return `${base}-${Math.max(...suffixes) + 1}`;
}

// Log staff action to staff_action_log
async function logStaffAction(env, staffId, action, targetType, targetId, details = null) {
    await env.DB.prepare(`
        INSERT INTO staff_action_log (staff_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).bind(staffId, action, targetType, targetId, details ? JSON.stringify(details) : null, now()).run()
      .catch(e => console.error('[broker] staff_action_log insert failed:', e.message));
}

// Phase order for broker application pipeline
const PHASE_ORDER = [
    'applied',
    'screening',
    'background_check',
    'interview',
    'contract',
    'approved'
];

// ── BROKER APPLICATION ROUTES ────────────────────────────────────────────────

/**
 * POST /v1/brokers/apply
 * Member submits a broker application. Must be an active member already.
 * Requires member JWT (called from member-side route in index.js).
 */
export async function handleApplyBroker(request, env, memberId) {
    // Consent check (L064)
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    // Verify the member exists and is active
    const member = await env.DB.prepare(
        "SELECT id, name, email, status, role FROM members WHERE id = ?"
    ).bind(memberId).first();

    if (!member || member.status !== 'active') {
        return Response.json({ error: 'Account must be active to apply as a broker.' }, { status: 403 });
    }
    if (member.role === 'broker') {
        return Response.json({ error: 'You are already a verified broker.' }, { status: 409 });
    }

    // Check if a pending/active application already exists
    const existingApp = await env.DB.prepare(
        "SELECT id, phase FROM broker_applications WHERE member_id = ? AND phase NOT IN ('rejected')"
    ).bind(memberId).first();

    if (existingApp) {
        return Response.json({
            error:   'Application already exists.',
            app_id:  existingApp.id,
            phase:   existingApp.phase
        }, { status: 409 });
    }

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const {
        full_legal_name,
        thai_id_hash,            // SHA-256 provided by client — never reversible
        physical_address,
        professional_background,
        years_in_collecting,
        specialties,             // array
        certificates,            // array of description strings
        references_text,
        reference_member_ids,    // array of member IDs
        insurance_provider,
        insurance_policy_number,
        insurance_expiry_date    // Unix timestamp
    } = body;

    if (!full_legal_name || !thai_id_hash || !physical_address) {
        return Response.json({
            error: 'full_legal_name, thai_id_hash, and physical_address are required.'
        }, { status: 400 });
    }

    const ts = now();
    const result = await env.DB.prepare(`
        INSERT INTO broker_applications (
            member_id, full_legal_name, thai_id_hash, physical_address,
            professional_background, years_in_collecting,
            specialties, certificates, references_text, reference_member_ids,
            insurance_provider, insurance_policy_number, insurance_expiry_date,
            phase, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)
    `).bind(
        memberId,
        full_legal_name,
        thai_id_hash,
        physical_address,
        professional_background ?? null,
        years_in_collecting ?? null,
        specialties         ? JSON.stringify(specialties)          : null,
        certificates        ? JSON.stringify(certificates)         : null,
        references_text     ?? null,
        reference_member_ids ? JSON.stringify(reference_member_ids) : null,
        insurance_provider       ?? null,
        insurance_policy_number  ?? null,
        insurance_expiry_date    ?? null,
        ts, ts
    ).run();

    const appId = result.meta?.last_row_id;

    // Notify owner of new application (L067)
    await queueNotification(env, 'csmittee@gmail.com', 'broker_application_received', {
        app_id:   appId,
        name:     full_legal_name,
        email:    member.email
    });

    return Response.json({
        success: true,
        message: 'Broker application submitted. Our team will review it within 5 business days.',
        app_id:  appId,
        phase:   'applied'
    }, { status: 201 });
}


/**
 * GET /v1/admin/brokers
 * List all broker applications with optional filter.
 * Staff JWT required.
 */
export async function handleListBrokerApps(request, env, staff) {
    const url    = new URL(request.url);
    const phase  = url.searchParams.get('phase') ?? null;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    const where  = phase ? 'WHERE ba.phase = ?' : '';
    const params = phase ? [phase, limit, offset] : [limit, offset];

    const apps = await env.DB.prepare(`
        SELECT
            ba.id, ba.member_id, ba.full_legal_name, ba.phase,
            ba.insurance_provider, ba.insurance_expiry_date,
            ba.bank_verified, ba.mail_verified, ba.video_call_done,
            ba.assigned_to, ba.approved_by, ba.created_at, ba.updated_at,
            m.email, m.username
        FROM broker_applications ba
        JOIN members m ON m.id = ba.member_id
        ${where}
        ORDER BY ba.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(...params).all();

    return Response.json({ applications: apps.results ?? [] });
}


/**
 * GET /v1/admin/brokers/:id
 * Full detail of a single broker application.
 * Staff JWT required.
 */
export async function handleGetBrokerApp(appId, env) {
    const app = await env.DB.prepare(`
        SELECT
            ba.*,
            m.email, m.username, m.name AS member_name, m.status AS member_status,
            s.name AS assigned_staff_name
        FROM broker_applications ba
        JOIN members m ON m.id = ba.member_id
        LEFT JOIN staff s ON s.id = ba.assigned_to
        WHERE ba.id = ?
    `).bind(appId).first();

    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    // Parse JSON fields
    ['specialties','certificates','reference_member_ids'].forEach(f => {
        if (app[f]) {
            try { app[f] = JSON.parse(app[f]); } catch { /* leave as string */ }
        }
    });

    return Response.json({ application: app });
}


/**
 * POST /v1/admin/brokers/:id/advance
 * Move application to the next phase.
 * ops_manager or owner only.
 */
export async function handleAdvanceBrokerPhase(appId, request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const app = await env.DB.prepare(
        "SELECT id, phase, member_id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();

    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    const currentIdx = PHASE_ORDER.indexOf(app.phase);
    if (currentIdx === -1 || app.phase === 'approved' || app.phase === 'rejected') {
        return Response.json({ error: `Cannot advance from phase: ${app.phase}` }, { status: 409 });
    }

    const nextPhase = PHASE_ORDER[currentIdx + 1];
    const ts        = now();

    let body = {};
    try { body = await request.json(); } catch { /* notes optional */ }

    await env.DB.prepare(`
        UPDATE broker_applications
        SET phase=?, assigned_to=?, updated_at=?
        WHERE id=?
    `).bind(nextPhase, staff.id, ts, appId).run();

    await logStaffAction(env, staff.id, 'broker_phase_advance', 'broker_application', appId, {
        from: app.phase, to: nextPhase, notes: body.notes ?? null
    });

    // Queue notification to the applicant's email
    const member = await env.DB.prepare(
        "SELECT email FROM members WHERE id = ?"
    ).bind(app.member_id).first();
    if (member?.email) {
        await queueNotification(env, member.email, 'broker_phase_advanced', {
            app_id: appId, phase: nextPhase
        }, app.member_id);
    }

    return Response.json({ success: true, app_id: appId, phase: nextPhase });
}


/**
 * POST /v1/admin/brokers/:id/approve
 * Approve broker application — grants broker status, generates broker_code.
 * ops_manager or owner only. Checks max_broker_count from platform_config (L061).
 */
export async function handleApproveBroker(appId, request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const app = await env.DB.prepare(
        "SELECT id, phase, member_id, full_legal_name FROM broker_applications WHERE id = ?"
    ).bind(appId).first();

    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });
    if (app.phase !== 'contract') {
        return Response.json({
            error: `Can only approve from 'contract' phase. Current phase: ${app.phase}`
        }, { status: 409 });
    }

    // Check max_broker_count (L061 — from platform_config)
    const config         = await getPlatformConfig(env);
    const maxBrokers     = parseInt(config.max_broker_count ?? '5');
    const activeBrokers  = await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM members WHERE role='broker' AND status='active'"
    ).first();

    if ((activeBrokers?.cnt ?? 0) >= maxBrokers) {
        return Response.json({
            error: `Platform broker limit reached (${maxBrokers}). Increase max_broker_count in config to proceed.`
        }, { status: 409 });
    }

    const member = await env.DB.prepare(
        "SELECT id, email, name FROM members WHERE id = ?"
    ).bind(app.member_id).first();
    if (!member) return Response.json({ error: 'Member not found.' }, { status: 404 });

    // Generate unique broker code (L065)
    const brokerCode = await generateBrokerCode(env, member.name);
    const ts         = now();

    // Promote member to broker role
    await env.DB.prepare(`
        UPDATE members
        SET role='broker', status='active', broker_code=?, verified_by=?, verified_at=?
        WHERE id=?
    `).bind(brokerCode, staff.id, ts, app.member_id).run();

    // Mark application approved
    await env.DB.prepare(`
        UPDATE broker_applications
        SET phase='approved', approved_by=?, approved_at=?, updated_at=?
        WHERE id=?
    `).bind(staff.id, ts, ts, appId).run();

    await logStaffAction(env, staff.id, 'broker_approved', 'broker_application', appId, {
        broker_code: brokerCode, member_id: app.member_id
    });

    // Notify applicant + owner + legal (L066, L067)
    await queueNotification(env, member.email, 'broker_approved', {
        name: member.name, broker_code: brokerCode
    }, member.id);
    await notifyOwnerAndLegal(env, 'broker_approved_admin', {
        app_id: appId, broker_code: brokerCode, name: member.name
    });

    return Response.json({
        success:     true,
        message:     'Broker approved.',
        member_id:   app.member_id,
        broker_code: brokerCode
    });
}


/**
 * POST /v1/admin/brokers/:id/reject
 * Reject an application. ops_manager or owner only.
 */
export async function handleRejectBroker(appId, request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const app = await env.DB.prepare(
        "SELECT id, phase, member_id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();

    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });
    if (app.phase === 'approved') {
        return Response.json({ error: 'Cannot reject an already approved application.' }, { status: 409 });
    }

    let body = {};
    try { body = await request.json(); } catch { /* rejection_reason optional but encouraged */ }

    const ts = now();
    await env.DB.prepare(`
        UPDATE broker_applications
        SET phase='rejected', rejection_reason=?, updated_at=?
        WHERE id=?
    `).bind(body.rejection_reason ?? null, ts, appId).run();

    await logStaffAction(env, staff.id, 'broker_rejected', 'broker_application', appId, {
        reason: body.rejection_reason ?? null
    });

    const member = await env.DB.prepare(
        "SELECT email FROM members WHERE id = ?"
    ).bind(app.member_id).first();
    if (member?.email) {
        await queueNotification(env, member.email, 'broker_rejected', {
            app_id: appId, reason: body.rejection_reason ?? null
        }, app.member_id);
    }

    return Response.json({ success: true, app_id: appId, phase: 'rejected' });
}


/**
 * POST /v1/admin/brokers/:id/suspend
 * Suspend an active broker. ops_manager or owner only.
 */
export async function handleSuspendBroker(appId, request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    // appId here is the broker_applications.id — resolve member_id
    const app = await env.DB.prepare(
        "SELECT id, member_id FROM broker_applications WHERE id = ? AND phase='approved'"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Approved broker application not found.' }, { status: 404 });

    const member = await env.DB.prepare(
        "SELECT id, email, status FROM members WHERE id = ? AND role='broker'"
    ).bind(app.member_id).first();
    if (!member) return Response.json({ error: 'Broker member not found.' }, { status: 404 });
    if (member.status === 'suspended') {
        return Response.json({ error: 'Broker is already suspended.' }, { status: 409 });
    }

    let body = {};
    try { body = await request.json(); } catch { /* reason encouraged */ }

    await env.DB.prepare(
        "UPDATE members SET status='suspended' WHERE id=?"
    ).bind(member.id).run();

    // Raise a manual flag for the suspension (L063 — audit trail)
    await env.DB.prepare(`
        INSERT INTO broker_flags
            (broker_member_id, raised_by, flag_type, severity, description, status, auto_suspended, created_at)
        VALUES (?, ?, 'manual', 'high', ?, 'investigating', 1, ?)
    `).bind(member.id, staff.id, body.reason ?? 'Manual suspension by staff.', now()).run();

    await logStaffAction(env, staff.id, 'broker_suspended', 'member', member.id, {
        reason: body.reason ?? null
    });

    await queueNotification(env, member.email, 'broker_suspended', {
        reason: body.reason ?? 'Your broker account has been suspended. Please contact support.'
    }, member.id);
    await notifyOwnerAndLegal(env, 'broker_suspended_admin', {
        member_id: member.id, reason: body.reason ?? null, suspended_by: staff.id
    });

    return Response.json({ success: true, message: 'Broker suspended.' });
}


/**
 * POST /v1/admin/brokers/:id/reinstate
 * Lift a suspension. Owner only.
 */
export async function handleReinstateBroker(appId, request, env, staff) {
    if (staff.role !== 'owner') {
        return Response.json({ error: 'Only the owner can reinstate a broker.' }, { status: 403 });
    }

    const app = await env.DB.prepare(
        "SELECT id, member_id FROM broker_applications WHERE id = ? AND phase='approved'"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Approved broker application not found.' }, { status: 404 });

    const member = await env.DB.prepare(
        "SELECT id, email, status FROM members WHERE id = ? AND role='broker'"
    ).bind(app.member_id).first();
    if (!member) return Response.json({ error: 'Broker member not found.' }, { status: 404 });
    if (member.status === 'active') {
        return Response.json({ error: 'Broker is already active.' }, { status: 409 });
    }

    let body = {};
    try { body = await request.json(); } catch { /* notes optional */ }

    await env.DB.prepare(
        "UPDATE members SET status='active' WHERE id=?"
    ).bind(member.id).run();

    await logStaffAction(env, staff.id, 'broker_reinstated', 'member', member.id, {
        notes: body.notes ?? null
    });

    await queueNotification(env, member.email, 'broker_reinstated', {
        message: 'Your broker account has been reinstated.'
    }, member.id);

    return Response.json({ success: true, message: 'Broker reinstated.' });
}


// ── DOCUMENT ROUTES ───────────────────────────────────────────────────────────

/**
 * POST /v1/admin/brokers/:id/documents
 * Attach a document record. r2_key must be AES-256-GCM encrypted by caller
 * before passing to this endpoint (Worker encrypts on upload via crypto.js).
 * Staff JWT required.
 */
export async function handleAttachBrokerDocument(appId, request, env, staff) {
    const app = await env.DB.prepare(
        "SELECT id, member_id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const { doc_type, r2_key_encrypted, file_hash, expiry_date, notes } = body;

    if (!doc_type || !r2_key_encrypted) {
        return Response.json({ error: 'doc_type and r2_key_encrypted are required.' }, { status: 400 });
    }

    const VALID_TYPES = [
        'thai_id_front','thai_id_back','insurance_policy','signed_contract',
        'video_call_recording','bank_statement','certificate','other'
    ];
    if (!VALID_TYPES.includes(doc_type)) {
        return Response.json({ error: `Invalid doc_type. Allowed: ${VALID_TYPES.join(', ')}` }, { status: 400 });
    }

    const result = await env.DB.prepare(`
        INSERT INTO broker_documents
            (broker_app_id, broker_member_id, doc_type, r2_key, file_hash,
             expiry_date, uploaded_by, uploaded_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        appId, app.member_id, doc_type,
        r2_key_encrypted,               // already encrypted by Worker crypto.js
        file_hash ?? null,
        expiry_date ?? null,
        staff.id, now(),
        notes ?? null
    ).run();

    await logStaffAction(env, staff.id, 'broker_doc_uploaded', 'broker_application', appId, {
        doc_type, doc_id: result.meta?.last_row_id
    });

    return Response.json({
        success: true,
        doc_id:  result.meta?.last_row_id,
        doc_type
    }, { status: 201 });
}


/**
 * GET /v1/admin/brokers/:id/documents
 * List document records for an application. r2_keys are encrypted — caller
 * must decrypt via crypto.js to get the actual R2 path.
 * Staff JWT required.
 */
export async function handleListBrokerDocuments(appId, env) {
    const app = await env.DB.prepare(
        "SELECT id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    const docs = await env.DB.prepare(`
        SELECT id, doc_type, r2_key, file_hash, expiry_date,
               uploaded_by, uploaded_at, notes
        FROM broker_documents
        WHERE broker_app_id = ?
        ORDER BY uploaded_at DESC
    `).bind(appId).all();

    return Response.json({ documents: docs.results ?? [] });
}


// ── COMPLIANCE ROUTES ─────────────────────────────────────────────────────────

/**
 * GET /v1/admin/brokers/:id/compliance
 * Full compliance check history for a broker application / member.
 * Staff JWT required.
 */
export async function handleListComplianceChecks(appId, env) {
    // Resolve member_id from app
    const app = await env.DB.prepare(
        "SELECT member_id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    const checks = await env.DB.prepare(`
        SELECT bcc.*, s.name AS reviewer_name
        FROM broker_compliance_checks bcc
        LEFT JOIN staff s ON s.id = bcc.reviewer_id
        WHERE bcc.broker_member_id = ?
        ORDER BY bcc.scheduled_at DESC
    `).bind(app.member_id).all();

    return Response.json({ compliance_checks: checks.results ?? [] });
}


/**
 * POST /v1/admin/brokers/:id/compliance
 * Initiate a manual spot check against a broker.
 * compliance_auditor or owner only.
 */
export async function handleCreateComplianceCheck(appId, request, env, staff) {
    if (!['compliance_auditor','owner','ops_manager'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const app = await env.DB.prepare(
        "SELECT member_id FROM broker_applications WHERE id = ? AND phase='approved'"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Approved broker application not found.' }, { status: 404 });

    let body = {};
    try { body = await request.json(); } catch { /* check_type optional */ }

    const checkType = body.check_type ?? 'manual_spot';
    const VALID_CHECK_TYPES = ['manual_spot','phone_verification','chat_review','scheduled_14day'];
    if (!VALID_CHECK_TYPES.includes(checkType)) {
        return Response.json({ error: `Invalid check_type. Allowed: ${VALID_CHECK_TYPES.join(', ')}` }, { status: 400 });
    }

    const ts     = now();
    const result = await env.DB.prepare(`
        INSERT INTO broker_compliance_checks
            (broker_member_id, check_type, scheduled_at, result,
             reviewer_id, lawyer_notified, created_at)
        VALUES (?, ?, ?, 'pending', ?, 1, ?)
    `).bind(app.member_id, checkType, ts, staff.id, ts).run();

    const checkId = result.meta?.last_row_id;

    await logStaffAction(env, staff.id, 'compliance_check_created', 'broker_member', app.member_id, {
        check_id: checkId, check_type: checkType
    });

    // Option C — always notify owner + legal_officer (L066)
    await notifyOwnerAndLegal(env, 'compliance_check_initiated', {
        check_id: checkId, broker_member_id: app.member_id, check_type: checkType
    });

    return Response.json({
        success:    true,
        check_id:   checkId,
        check_type: checkType,
        result:     'pending'
    }, { status: 201 });
}


/**
 * POST /v1/admin/brokers/:id/compliance/:checkId/result
 * Record the result of a compliance check.
 * Staff JWT required. Auto-suspends broker if result is 'fail' or 'no_response'.
 */
export async function handleRecordComplianceResult(appId, checkId, request, env, staff) {
    const check = await env.DB.prepare(
        "SELECT * FROM broker_compliance_checks WHERE id = ?"
    ).bind(checkId).first();
    if (!check) return Response.json({ error: 'Compliance check not found.' }, { status: 404 });

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const { result, notes, flags_raised, phone_code_received } = body;
    const VALID_RESULTS = ['pass','fail','no_response'];
    if (!result || !VALID_RESULTS.includes(result)) {
        return Response.json({ error: `result must be one of: ${VALID_RESULTS.join(', ')}` }, { status: 400 });
    }

    const ts              = now();
    const autoSuspend     = (result === 'fail' || result === 'no_response') ? 1 : 0;
    const flagsCount      = parseInt(flags_raised ?? '0');

    await env.DB.prepare(`
        UPDATE broker_compliance_checks
        SET result=?, completed_at=?, reviewer_id=?, notes=?,
            flags_raised=?, auto_suspended=?,
            phone_code_received=?
        WHERE id=?
    `).bind(
        result, ts, staff.id,
        notes ?? null, flagsCount, autoSuspend,
        phone_code_received ?? null,
        checkId
    ).run();

    // Auto-suspend broker on fail/no_response
    if (autoSuspend) {
        await env.DB.prepare(
            "UPDATE members SET status='suspended' WHERE id=?"
        ).bind(check.broker_member_id).run();

        // Raise auto-generated flag
        await env.DB.prepare(`
            INSERT INTO broker_flags
                (broker_member_id, flag_type, severity, description, status, auto_suspended, created_at)
            VALUES (?, 'anomaly', 'critical', ?, 'open', 1, ?)
        `).bind(
            check.broker_member_id,
            `Compliance check ${checkId} result: ${result}. Auto-suspended.`,
            ts
        ).run();
    }

    await logStaffAction(env, staff.id, 'compliance_result_recorded', 'compliance_check', checkId, {
        result, auto_suspended: autoSuspend, flags_raised: flagsCount
    });

    // Always notify owner + legal (Option C — L066)
    await notifyOwnerAndLegal(env, 'compliance_result', {
        check_id:       checkId,
        broker_member_id: check.broker_member_id,
        result,
        auto_suspended: autoSuspend,
        flags_raised:   flagsCount
    });

    return Response.json({
        success:       true,
        check_id:      checkId,
        result,
        auto_suspended: autoSuspend === 1
    });
}


// ── FLAG ROUTES ───────────────────────────────────────────────────────────────

/**
 * GET /v1/admin/brokers/:id/flags
 * List all flags raised against a broker.
 * Staff JWT required.
 */
export async function handleListBrokerFlags(appId, env) {
    const app = await env.DB.prepare(
        "SELECT member_id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    const flags = await env.DB.prepare(`
        SELECT bf.*,
               rs.name AS raised_by_name,
               rv.name AS resolved_by_name
        FROM broker_flags bf
        LEFT JOIN staff rs ON rs.id = bf.raised_by
        LEFT JOIN staff rv ON rv.id = bf.resolved_by
        WHERE bf.broker_member_id = ?
        ORDER BY bf.created_at DESC
    `).bind(app.member_id).all();

    return Response.json({ flags: flags.results ?? [] });
}


/**
 * POST /v1/admin/brokers/:id/flag
 * Raise a flag against a broker. Staff JWT required.
 * Critical severity → immediate auto-suspend → owner + legal alerted.
 */
export async function handleRaiseBrokerFlag(appId, request, env, staff) {
    const app = await env.DB.prepare(
        "SELECT member_id FROM broker_applications WHERE id = ?"
    ).bind(appId).first();
    if (!app) return Response.json({ error: 'Application not found.' }, { status: 404 });

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const { flag_type, severity, description, related_order_id, related_message_id } = body;

    const VALID_TYPES = [
        'complaint','anomaly','chat_violation','payment_bypass_attempt',
        'insurance_lapsed','phone_no_response','manual'
    ];
    const VALID_SEVERITIES = ['low','medium','high','critical'];

    if (!flag_type || !VALID_TYPES.includes(flag_type)) {
        return Response.json({ error: `flag_type must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!severity || !VALID_SEVERITIES.includes(severity)) {
        return Response.json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` }, { status: 400 });
    }
    if (!description) {
        return Response.json({ error: 'description is required.' }, { status: 400 });
    }

    const autoSuspend = severity === 'critical' ? 1 : 0;
    const ts          = now();

    const result = await env.DB.prepare(`
        INSERT INTO broker_flags
            (broker_member_id, raised_by, flag_type, severity, description,
             related_order_id, related_message_id, status, auto_suspended, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).bind(
        app.member_id, staff.id, flag_type, severity, description,
        related_order_id ?? null, related_message_id ?? null,
        autoSuspend, ts
    ).run();

    const flagId = result.meta?.last_row_id;

    // Critical = auto-suspend (L063 — platform integrity)
    if (autoSuspend) {
        await env.DB.prepare(
            "UPDATE members SET status='suspended' WHERE id=?"
        ).bind(app.member_id).run();
    }

    await logStaffAction(env, staff.id, 'broker_flag_raised', 'member', app.member_id, {
        flag_id: flagId, flag_type, severity
    });

    // Notify owner + legal on medium+ severity
    if (['medium','high','critical'].includes(severity)) {
        await notifyOwnerAndLegal(env, 'broker_flag_raised', {
            flag_id: flagId, broker_member_id: app.member_id,
            flag_type, severity, auto_suspended: autoSuspend
        });
    }

    return Response.json({
        success:        true,
        flag_id:        flagId,
        severity,
        auto_suspended: autoSuspend === 1
    }, { status: 201 });
}


/**
 * POST /v1/admin/brokers/flags/:flagId/resolve
 * Resolve or dismiss a flag. ops_manager or owner only.
 */
export async function handleResolveBrokerFlag(flagId, request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const flag = await env.DB.prepare(
        "SELECT * FROM broker_flags WHERE id = ?"
    ).bind(flagId).first();
    if (!flag) return Response.json({ error: 'Flag not found.' }, { status: 404 });
    if (flag.status === 'resolved' || flag.status === 'dismissed') {
        return Response.json({ error: `Flag is already ${flag.status}.` }, { status: 409 });
    }

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const newStatus = body.status === 'dismissed' ? 'dismissed' : 'resolved';

    await env.DB.prepare(`
        UPDATE broker_flags
        SET status=?, resolved_by=?, resolved_at=?, resolution_notes=?
        WHERE id=?
    `).bind(newStatus, staff.id, now(), body.resolution_notes ?? null, flagId).run();

    await logStaffAction(env, staff.id, 'broker_flag_resolved', 'broker_flag', flagId, {
        status: newStatus, notes: body.resolution_notes ?? null
    });

    return Response.json({ success: true, flag_id: flagId, status: newStatus });
}


// ── PAYMENT VIOLATION REPORTS ─────────────────────────────────────────────────

/**
 * POST /v1/brokers/report
 * Buyer reports that broker solicited payment outside the platform.
 * Member JWT required. First report = immediate auto-suspend (L063).
 */
export async function handleReportPaymentBypass(request, env, memberId) {
    // Consent check (L064)
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const { broker_member_id, listing_id, order_id, description, evidence_r2_keys } = body;

    if (!broker_member_id || !description) {
        return Response.json({ error: 'broker_member_id and description are required.' }, { status: 400 });
    }
    if (description.length < 20) {
        return Response.json({ error: 'Please provide a detailed description (at least 20 characters).' }, { status: 400 });
    }

    // Verify the accused is actually a broker
    const broker = await env.DB.prepare(
        "SELECT id, email, status FROM members WHERE id = ? AND role='broker'"
    ).bind(broker_member_id).first();
    if (!broker) {
        return Response.json({ error: 'Broker not found.' }, { status: 404 });
    }

    const ts = now();

    // Auto-suspend broker immediately on ANY payment bypass report (L063 — hardcoded)
    await env.DB.prepare(
        "UPDATE members SET status='suspended' WHERE id=?"
    ).bind(broker_member_id).run();

    const result = await env.DB.prepare(`
        INSERT INTO payment_outside_platform_reports
            (reporter_member_id, broker_member_id, listing_id, order_id,
             description, evidence_r2_keys, auto_suspended, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'investigating', ?)
    `).bind(
        memberId, broker_member_id,
        listing_id ?? null, order_id ?? null,
        description,
        evidence_r2_keys ? JSON.stringify(evidence_r2_keys) : null,
        ts
    ).run();

    const reportId = result.meta?.last_row_id;

    // Raise a critical flag automatically
    await env.DB.prepare(`
        INSERT INTO broker_flags
            (broker_member_id, flag_type, severity, description, status, auto_suspended, created_at)
        VALUES (?, 'payment_bypass_attempt', 'critical', ?, 'investigating', 1, ?)
    `).bind(
        broker_member_id,
        `Payment outside platform report #${reportId} submitted by member ${memberId}.`,
        ts
    ).run();

    // Alert owner + legal immediately (this is the #1 scam vector)
    await notifyOwnerAndLegal(env, 'payment_bypass_reported', {
        report_id:        reportId,
        reporter_id:      memberId,
        broker_member_id,
        listing_id:       listing_id ?? null,
        order_id:         order_id ?? null,
        auto_suspended:   true
    });

    return Response.json({
        success:   true,
        report_id: reportId,
        message:   'Your report has been received. The broker has been suspended pending investigation. Our team will review this within 24 hours.'
    }, { status: 201 });
}


/**
 * GET /v1/admin/brokers/reports
 * List all payment bypass reports. ops_manager or owner only.
 */
export async function handleListPaymentReports(request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const url    = new URL(request.url);
    const status = url.searchParams.get('status') ?? null;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    const where  = status ? 'WHERE r.status = ?' : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    const reports = await env.DB.prepare(`
        SELECT r.*,
               reporter.username AS reporter_username,
               broker.username   AS broker_username, broker.broker_code
        FROM payment_outside_platform_reports r
        JOIN members reporter ON reporter.id = r.reporter_member_id
        JOIN members broker   ON broker.id   = r.broker_member_id
        ${where}
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(...params).all();

    return Response.json({ reports: reports.results ?? [] });
}


/**
 * POST /v1/admin/brokers/reports/:reportId/resolve
 * Resolve a payment bypass investigation. ops_manager or owner only.
 */
export async function handleResolvePaymentReport(reportId, request, env, staff) {
    if (!['ops_manager','owner'].includes(staff.role)) {
        return Response.json({ error: 'Insufficient permissions.' }, { status: 403 });
    }

    const report = await env.DB.prepare(
        "SELECT * FROM payment_outside_platform_reports WHERE id = ?"
    ).bind(reportId).first();
    if (!report) return Response.json({ error: 'Report not found.' }, { status: 404 });
    if (report.status !== 'investigating') {
        return Response.json({ error: `Report is already ${report.status}.` }, { status: 409 });
    }

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }

    const { status: newStatus, outcome } = body;
    const VALID = ['confirmed','dismissed'];
    if (!newStatus || !VALID.includes(newStatus)) {
        return Response.json({ error: 'status must be "confirmed" or "dismissed".' }, { status: 400 });
    }

    const ts = now();
    await env.DB.prepare(`
        UPDATE payment_outside_platform_reports
        SET status=?, investigated_by=?, outcome=?, resolved_at=?
        WHERE id=?
    `).bind(newStatus, staff.id, outcome ?? null, ts, reportId).run();

    // Confirmed = permanent ban
    if (newStatus === 'confirmed') {
        await env.DB.prepare(
            "UPDATE members SET status='banned' WHERE id=?"
        ).bind(report.broker_member_id).run();

        const broker = await env.DB.prepare(
            "SELECT email FROM members WHERE id = ?"
        ).bind(report.broker_member_id).first();
        if (broker?.email) {
            await queueNotification(env, broker.email, 'broker_banned', {
                reason: 'Payment outside platform — contract breach. Account permanently banned.'
            }, report.broker_member_id);
        }
    } else {
        // Dismissed — reinstate broker
        await env.DB.prepare(
            "UPDATE members SET status='active' WHERE id=?"
        ).bind(report.broker_member_id).run();
    }

    await logStaffAction(env, staff.id, 'payment_report_resolved', 'payment_report', reportId, {
        status: newStatus, outcome
    });

    await notifyOwnerAndLegal(env, 'payment_report_resolved', {
        report_id:  reportId,
        status:     newStatus,
        outcome,
        broker_id:  report.broker_member_id
    });

    return Response.json({ success: true, report_id: reportId, status: newStatus });
}
