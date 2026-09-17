if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ path: '.env.local' });
}

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const stripeRestricted = require('stripe')(process.env.STRIPE_RESTRICTED);
const Pusher = require("pusher");

const pusher = new Pusher({
    appId: "1817619",
    key: "f970d7239aada8585e32",
    secret: "0e20af4e049543b1356c",
    cluster: "ap2",
    useTLS: true
});

const app = express();
const port = 4000;
const reportChannel = 'my-channel';
const onboardingApiBaseUrl = 'https://onboarding-backend-orcin.vercel.app/api/onboarding';


async function downloadStripeIdentityFile(fileId) {
    if (!fileId) return null;

    // Create a temporary FileLink using the restricted key
    const fileLink = await stripeRestricted.fileLinks.create({
        file: fileId,
        expires_at: Math.floor(Date.now() / 1000) + 30
    });

    // Download the actual image bytes immediately
    const response = await fetch(fileLink.url);

    if (!response.ok) {
        throw new Error(
            `Failed to download Stripe Identity file ${fileId}: ${response.status}`
        );
    }

    const contentType =
        response.headers.get('content-type') || 'application/octet-stream';

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
        fileId,
        contentType,
        base64: buffer.toString('base64')
    };
}

async function handleVerifiedSession(event) {
    const session = event.data.object;
    const ownerSub = session.metadata?.ownerSub;
    const onboardingId = parseOnboardingId(session.metadata?.onboardingId);

    if (!ownerSub) {
        throw new Error(
            `Verification session ${session.id} has no ownerSub metadata`
        );
    }

    if (!onboardingId) {
        throw new Error(`Verification session ${session.id} has an invalid onboardingId`);
    }

    const onboardingRecord = await fetchOnboardingRecord(onboardingId);
    assertRecordOwner(onboardingRecord, ownerSub);

    if (!session.last_verification_report) {
        throw new Error(
            `Verification session ${session.id} has no verification report`
        );
    }

    // 1. Get report from Stripe
    const report =
        await stripe.identity.verificationReports.retrieve(
            session.last_verification_report
        );

    const sensitiveSession =
        await stripeRestricted.identity.verificationSessions.retrieve(
            session.id,
            {
                expand: [
                    'last_verification_report.document.expiration_date',
                    'last_verification_report.document.number',
                    'verified_outputs.dob',
                    'verified_outputs.id_number'
                ]
            }
        );

    const sensitiveReport = sensitiveSession.last_verification_report;

    if (sensitiveReport && typeof sensitiveReport !== 'string') {
        report.document = {
            ...report.document,
            expiration_date:
                sensitiveReport.document?.expiration_date,
            number:
                sensitiveReport.document?.number
        };

        report.verified_outputs = {
            ...report.verified_outputs,
            dob:
                sensitiveSession.verified_outputs?.dob,
            id_number:
                sensitiveSession.verified_outputs?.id_number
        };
    }

    const documentFileId =
        report.document?.files?.[0];

    const selfieFileId =
        report.selfie?.selfie;

    const documentFile =
        await downloadStripeIdentityFile(documentFileId);

    const selfieFile =
        await downloadStripeIdentityFile(selfieFileId);

    report.identityFiles = {
        document: documentFile,
        selfie: selfieFile
    };

    // 2. Save report/update onboarding FIRST
    await saveVerificationReport(onboardingRecord, session, report);

    // 3. Only tell frontend AFTER save succeeded
    await pusher.trigger(
        reportChannel,
        'verification-report',
        {
            ownerSub,
            onboardingId,
            sessionId: session.id,
            reportId: report.id,
            status: session.status
        }
    );
}

async function handleFailedVerification(event) {
    const session = event.data.object;
    console.log('Verification requires input:', session.id, session.metadata?.onboardingId);
}

app.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        let event;
        console.log("WEBHOOK TRIGGERED");

        try {
            const signature = req.headers['stripe-signature'];

            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error(
                'Invalid Stripe webhook signature:',
                err.message
            );

            return res.status(400).send('Invalid signature');
        }

        try {
            switch (event.type) {
                case 'identity.verification_session.verified':
                    await handleVerifiedSession(event);
                    break;

                case 'identity.verification_session.requires_input':
                    await handleFailedVerification(event);
                    break;

                default:
                    break;
            }

            return res.sendStatus(200);
        } catch (err) {
            console.error('Stripe webhook processing failed:', err);
            return res.sendStatus(500);
        }
    }
);


// Middleware
app.use(cors());
app.use(bodyParser.json());

function normalizeName(str) {
    if (typeof str !== 'string') return '';
    return str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractFieldValue(field) {
    if (!field) return '';
    if (typeof field === 'object' && field.value !== undefined) return field.value;
    if (typeof field === 'string') return field;
    return '';
}

function getOnboardingData(onboardingRecord) {
    return onboardingRecord.data || onboardingRecord;
}

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function canEvaluateApproval(target) {
    return target === 'primary';
}

function parseOnboardingId(value) {
    const id = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getRecordOwner(record) {
    return record?.owner_sub;
}

function getOnboardingType(record) {
    return record?.data?.wizard?.selectedAccountType || '';
}

function validateOnboardingType(record, requestedType) {
    const type = getOnboardingType(record);
    if (!['personal', 'business'].includes(type)) {
        const error = new Error('Selected onboarding has an invalid onboarding type');
        error.status = 422;
        throw error;
    }
    if (requestedType && requestedType !== type) {
        const error = new Error('Onboarding type does not match the selected onboarding');
        error.status = 422;
        throw error;
    }
    return type;
}

function assertRecordOwner(record, ownerSub) {
    if (!record || getRecordOwner(record) !== ownerSub) {
        const error = new Error('Onboarding record not found');
        error.status = 404;
        throw error;
    }
}

function buildVerificationMetadata(onboardingRecord, target, entityId, entityKind) {
    return {
        ownerSub: getRecordOwner(onboardingRecord),
        onboardingId: String(onboardingRecord.id),
        onboardingType: String(getOnboardingType(onboardingRecord)),
        target,
        ...(entityId ? { entityId: String(entityId) } : {}),
        ...(entityKind ? { entityKind } : {})
    };
}

function getCoApplicants(onboardingRecord) {
    const data = getOnboardingData(onboardingRecord);
    if (Array.isArray(data.coApplicants)) return data.coApplicants;
    return data.coApplicant ? [data.coApplicant] : [];
}

function findCoApplicant(onboardingRecord, email) {
    const normalizedEmail = normalizeEmail(email);
    return getCoApplicants(onboardingRecord).find(
        (coApplicant) => normalizeEmail(coApplicant.email) === normalizedEmail
    );
}

function checkApplicantNameMatch(applicant, stripeReport) {
    if (!stripeReport || !stripeReport.document) return false;

    const details = applicant?.details || applicant || {};
    const submittedFirstName = extractFieldValue(details.firstName);
    const submittedLastName = extractFieldValue(details.lastName);

    const stripeFirstName = stripeReport.document?.first_name || '';
    const stripeLastName = stripeReport.document?.last_name || '';

    const normStripeFirst = normalizeName(stripeFirstName);
    const normStripeLast = normalizeName(stripeLastName);
    const normSubFirst = normalizeName(submittedFirstName);
    const normSubLast = normalizeName(submittedLastName);

    return !!(normStripeFirst && normStripeLast && normStripeFirst === normSubFirst && normStripeLast === normSubLast);
}

function checkNameMatch(onboardingRecord, stripeReport, target = 'primary') {
    if (target === 'coApplicant') {
        return getCoApplicants(onboardingRecord).some((coApplicant) =>
            checkApplicantNameMatch(coApplicant, stripeReport)
        );
    }

    const data = getOnboardingData(onboardingRecord);
    return checkApplicantNameMatch(data.details, stripeReport);
}

function isVerifiedAndMatched(onboardingRecord, applicant, target) {
    const verification = applicant?.stripeVerification;
    return applicant?.identityVerificationComplete === true &&
        verification?.status === 'verified' &&
        (target === 'coApplicant'
            ? checkApplicantNameMatch(applicant, verification.report)
            : checkNameMatch(onboardingRecord, verification.report, target));
}

function isReadyForApproval(onboardingRecord) {
    const data = getOnboardingData(onboardingRecord);
    const primary = data.wizard;

    if (!isVerifiedAndMatched(onboardingRecord, primary, 'primary')) {
        return false;
    }

    const businessParticipants = [
        ...(Array.isArray(data.representatives) ? data.representatives : []),
        ...(Array.isArray(data.directors) ? data.directors : [])
    ];
    if (businessParticipants.length > 0) {
        return businessParticipants.every((participant) =>
            isVerifiedAndMatched(onboardingRecord, participant, 'coApplicant')
        );
    }

    const selection = primary?.personalAccountSelection;
    if (!selection?.jointAccount) return true;

    const expectedCoApplicants = selection.coApplicants || [];
    return expectedCoApplicants.length > 0 && expectedCoApplicants.length <= 2 &&
        expectedCoApplicants.every((coApplicant) => {
        const email = normalizeEmail(coApplicant.email);
        const completedCoApplicant = coApplicant.identityVerificationComplete === true
            ? coApplicant
            : findCoApplicant(onboardingRecord, email);
        return !!email && isVerifiedAndMatched(
            onboardingRecord,
            completedCoApplicant,
            'coApplicant'
        );
    });
}

function buildCoApplicantPatch(onboardingRecord, email, stripeVerification) {
    const data = getOnboardingData(onboardingRecord);
    const selection = data.wizard?.personalAccountSelection;
    const selectedCoApplicant = selection?.coApplicants?.find(
        (applicant) => normalizeEmail(applicant.email) === normalizeEmail(email)
    );
    const coApplicant = selectedCoApplicant || findCoApplicant(onboardingRecord, email);

    if (!coApplicant) {
        throw new Error(`No co-applicant found for ${email}`);
    }

    const updatedCoApplicant = {
        ...coApplicant,
        identityVerificationComplete: true,
        stripeVerification
    };

    if (selectedCoApplicant) {
        return {
            wizard: {
                personalAccountSelection: {
                    ...selection,
                    coApplicants: selection.coApplicants.map((applicant) =>
                        normalizeEmail(applicant.email) === normalizeEmail(email)
                            ? updatedCoApplicant
                            : applicant
                    )
                }
            }
        };
    }

    return {
        coApplicant: updatedCoApplicant,
        coApplicants: Array.isArray(data.coApplicants)
            ? data.coApplicants.map((applicant) =>
                normalizeEmail(applicant.email) === normalizeEmail(email)
                    ? updatedCoApplicant
                    : applicant
            )
            : undefined
    };
}

function getEntityCollection(data, entityKind) {
    if (entityKind === 'representative') return data.representatives;
    if (entityKind === 'director') return data.directors;
    return null;
}

function getEntityId(entity) {
    return String(entity?.id ?? entity?.entityId ?? '');
}

function buildEntityPatch(onboardingRecord, entityId, entityKind, stripeVerification) {
    const data = getOnboardingData(onboardingRecord);
    const entities = getEntityCollection(data, entityKind);
    if (!Array.isArray(entities)) {
        throw new Error(`Unsupported entityKind: ${entityKind}`);
    }

    const targetId = String(entityId);
    if (!entities.some((entity) => getEntityId(entity) === targetId)) {
        throw new Error(`No ${entityKind} found for ${entityId}`);
    }

    return {
        [entityKind === 'representative' ? 'representatives' : 'directors']:
            entities.map((entity) => getEntityId(entity) === targetId
                ? { ...entity, identityVerificationComplete: true, stripeVerification }
                : entity)
    };
}

function assertVerificationTargetExists(onboardingRecord, target, entityId, entityKind) {
    if (target === 'primary') return;
    if (target === 'coApplicant') {
        const data = getOnboardingData(onboardingRecord);
        const selected = data.wizard?.personalAccountSelection?.coApplicants || [];
        if (selected.some((applicant) => normalizeEmail(applicant.email) === normalizeEmail(entityId)) ||
            findCoApplicant(onboardingRecord, entityId)) return;
        throw new Error(`No co-applicant found for ${entityId}`);
    }
    buildEntityPatch(onboardingRecord, entityId, entityKind, {});
}

async function fetchOnboardingRecord(onboardingId) {
    const response = await fetch(`${onboardingApiBaseUrl}/${onboardingId}`);
    if (!response.ok) {
        const error = new Error(`Onboarding API returned ${response.status}`);
        error.status = response.status === 404 ? 404 : 502;
        throw error;
    }
    return response.json();
}

async function patchOnboardingRecord(onboardingId, ownerSub, patchPayload) {
    const response = await fetch(`${onboardingApiBaseUrl}/${onboardingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerSub, onboardingId, ...patchPayload })
    });

    if (!response.ok) {
        throw new Error(`Onboarding API returned ${response.status}: ${await response.text()}`);
    }
}

async function saveVerificationReport(onboardingRecord, session, report) {
    const ownerSub = session.metadata?.ownerSub;
    const onboardingId = parseOnboardingId(session.metadata?.onboardingId);
    const target = session.metadata?.target || 'primary';
    const entityId = session.metadata?.entityId;
    let patchPayload;

    if (target === 'coApplicant') {
        if (!normalizeEmail(entityId)) {
            throw new Error(`Co-applicant verification session ${session.id} has no entityId`);
        }

        patchPayload = buildCoApplicantPatch(onboardingRecord, entityId, {
            verificationSessionId: session.id,
            reportId: report.id,
            status: session.status,
            report
        });
    } else if (target === 'entity') {
        if (!entityId || !session.metadata?.entityKind) {
            throw new Error(`Entity verification session ${session.id} is missing entity metadata`);
        }
        patchPayload = buildEntityPatch(onboardingRecord, entityId, session.metadata.entityKind, {
            verificationSessionId: session.id,
            reportId: report.id,
            status: session.status,
            report
        });
    } else if (target === 'primary') {
        patchPayload = {
            wizard: {
                identityVerificationComplete: true,
                stripeVerification: {
                    verificationSessionId: session.id,
                    reportId: report.id,
                    status: session.status,
                    report
                }
            }
        };
    } else {
        throw new Error(`Unsupported verification target: ${target}`);
    }

    await patchOnboardingRecord(onboardingId, ownerSub, patchPayload);

    // Re-evaluate after every applicant update so the final verification can
    // approve the application, regardless of which applicant finishes last.
    const updatedRecord = await fetchOnboardingRecord(onboardingId);
    assertRecordOwner(updatedRecord, ownerSub);
    if (isReadyForApproval(updatedRecord)) {
        await patchOnboardingRecord(onboardingId, ownerSub, { reviewDecision: 'Accepted' });
    }
}

// Endpoint to re-evaluate name match and auto-approve (e.g. from frontend review summary)
app.post('/evaluate-approval', async (req, res) => {
    const { ownerSub, onboardingId, target } = req.body || {};

    if (typeof ownerSub !== 'string' || !ownerSub.trim()) {
        return res.status(400).json({ error: 'ownerSub is required' });
    }

    const recordId = parseOnboardingId(onboardingId);
    if (!recordId) {
        return res.status(400).json({ error: 'A positive numeric onboardingId is required' });
    }

    if (!canEvaluateApproval(target)) {
        return res.json({
            autoApproved: false,
            reason: 'Only the primary applicant can evaluate approval'
        });
    }

    try {
        const onboardingRecord = await fetchOnboardingRecord(recordId);
        assertRecordOwner(onboardingRecord, ownerSub);
        if (isReadyForApproval(onboardingRecord)) {
            await patchOnboardingRecord(recordId, ownerSub, { reviewDecision: 'Accepted' });
            return res.json({ autoApproved: true, reviewDecision: 'Accepted' });
        }

        return res.json({ autoApproved: false, reason: 'Not every required applicant is verified and name-matched' });
    } catch (error) {
        console.error('Error evaluating approval:', error);
        res.status(error.status || 500).json({ error: error.message });
    }
});

// Endpoint to create a verification session
app.post('/create-verification-session', async (req, res) => {
    const { ownerSub, onboardingId, onboardingType, target = 'primary', entityId, entityKind } = req.body || {};

    if (typeof ownerSub !== 'string' || !ownerSub.trim()) {
        return res.status(400).json({ error: 'ownerSub is required' });
    }

    const recordId = parseOnboardingId(onboardingId);
    if (!recordId) {
        return res.status(400).json({ error: 'A positive numeric onboardingId is required' });
    }

    if (target === 'coApplicant' && !normalizeEmail(entityId)) {
        return res.status(400).json({ error: 'entityId (the co-applicant email) is required' });
    }

    if (target === 'entity' && (!entityId || !['representative', 'director'].includes(entityKind))) {
        return res.status(400).json({ error: 'entityId and a valid entityKind are required' });
    }

    if (!['primary', 'coApplicant', 'entity'].includes(target)) {
        return res.status(400).json({ error: 'target must be primary, coApplicant, or entity' });
    }

    try {
        const onboardingRecord = await fetchOnboardingRecord(recordId);
        assertRecordOwner(onboardingRecord, ownerSub);
        validateOnboardingType(onboardingRecord, onboardingType);
        try {
            assertVerificationTargetExists(onboardingRecord, target, entityId, entityKind);
        } catch (error) {
            return res.status(404).json({ error: error.message });
        }

        const metadata = buildVerificationMetadata(onboardingRecord, target, entityId, entityKind);

        const verificationSession = await stripe.identity.verificationSessions.create({
            type: 'document',
            metadata,
            options: {
                document: {
                    require_matching_selfie: true
                }
            }
        });

        res.json({
            client_secret: verificationSession.client_secret,
            verification_session_id: verificationSession.id
        });
    } catch (error) {
        console.error('Error creating verification session:', error);
        res.status(error.status || 500).json({ error: error.message });
    }
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

module.exports = app;
module.exports._test = {
    buildCoApplicantPatch,
    buildEntityPatch,
    buildVerificationMetadata,
    canEvaluateApproval,
    isReadyForApproval,
    parseOnboardingId,
    assertRecordOwner,
    assertVerificationTargetExists,
    validateOnboardingType,
    fetchOnboardingRecord,
    patchOnboardingRecord
};
