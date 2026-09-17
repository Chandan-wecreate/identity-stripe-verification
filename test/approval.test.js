const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../index');

const reportFor = (firstName, lastName) => ({
    document: { first_name: firstName, last_name: lastName }
});

const verifiedApplicant = (email, firstName, lastName) => ({
    email,
    details: {
        firstName: { value: firstName },
        lastName: { value: lastName }
    },
    identityVerificationComplete: true,
    stripeVerification: { status: 'verified', report: reportFor(firstName, lastName) }
});

const primary = {
    identityVerificationComplete: true,
    stripeVerification: { status: 'verified', report: reportFor('Primary', 'Applicant') },
    personalAccountSelection: {
        jointAccount: true,
        coApplicants: [
            { email: 'first@example.com' },
            { email: 'second@example.com' }
        ]
    }
};

const recordWith = (coApplicants) => ({
    data: {
        details: {
            firstName: { value: 'Primary' },
            lastName: { value: 'Applicant' }
        },
        wizard: structuredClone(primary),
        coApplicants
    }
});

test('approves a joint account only after every co-applicant is verified and matched', () => {
    assert.equal(app._test.isReadyForApproval(recordWith([
        verifiedApplicant('first@example.com', 'First', 'Applicant'),
        verifiedApplicant('second@example.com', 'Second', 'Applicant')
    ])), true);
});

test('does not approve a joint account when a co-applicant name does not match', () => {
    assert.equal(app._test.isReadyForApproval(recordWith([
        verifiedApplicant('first@example.com', 'First', 'Applicant'),
        {
            ...verifiedApplicant('second@example.com', 'Second', 'Applicant'),
            stripeVerification: { status: 'verified', report: reportFor('Wrong', 'Name') }
        }
    ])), false);
});

test('does not approve an unfinished nested co-applicant', () => {
    const record = recordWith([
        verifiedApplicant('first@example.com', 'First', 'Applicant'),
        verifiedApplicant('second@example.com', 'Second', 'Applicant')
    ]);
    record.data.wizard.personalAccountSelection.coApplicants = [{
        email: 'joint@example.com',
        firstName: 'Joint',
        lastName: 'Applicant'
    }];
    assert.equal(app._test.isReadyForApproval(record), false);
});

test('does not approve a primary application without identity verification', () => {
    const record = recordWith([]);
    record.data.wizard.identityVerificationComplete = false;

    assert.equal(app._test.isReadyForApproval(record), false);
});

test('approves verified nested joint applicants', () => {
    const record = recordWith([]);
    record.data.wizard.personalAccountSelection.coApplicants = [
        verifiedApplicant('joint@example.com', 'Joint', 'Applicant')
    ];

    assert.equal(app._test.isReadyForApproval(record), true);
});

test('approves two nested joint applicants only after both verify', () => {
    const record = recordWith([]);
    record.data.wizard.personalAccountSelection.coApplicants = [
        verifiedApplicant('first@example.com', 'First', 'Applicant'),
        { email: 'second@example.com', firstName: 'Second', lastName: 'Applicant' }
    ];

    assert.equal(app._test.isReadyForApproval(record), false);

    record.data.wizard.personalAccountSelection.coApplicants[1] =
        verifiedApplicant('second@example.com', 'Second', 'Applicant');

    assert.equal(app._test.isReadyForApproval(record), true);
});

test('writes a co-applicant report to the matching nested applicant only', () => {
    const record = recordWith([
        verifiedApplicant('first@example.com', 'First', 'Applicant'),
        verifiedApplicant('second@example.com', 'Second', 'Applicant')
    ]);
    const patch = app._test.buildCoApplicantPatch(record, 'second@example.com', {
        status: 'verified',
        report: reportFor('Second', 'Applicant')
    });

    const applicants = patch.wizard.personalAccountSelection.coApplicants;
    assert.equal(applicants[0].stripeVerification, undefined);
    assert.equal(applicants[1].stripeVerification.report.document.first_name, 'Second');
});

test('does not evaluate approval for a co-applicant caller', () => {
    assert.equal(app._test.canEvaluateApproval('coApplicant'), false);
    assert.equal(app._test.canEvaluateApproval('primary'), true);
});

const record = (id, type, data) => ({
    id,
    owner_sub: 'auth0|abc123',
    data: {
        ...data,
        wizard: { ...data.wizard, selectedAccountType: type }
    }
});

test('accepts only positive numeric onboarding IDs', () => {
    for (const value of [undefined, null, 0, -1, '0', '-1', 'abc', 1.5]) {
        assert.equal(app._test.parseOnboardingId(value), null);
    }
    assert.equal(app._test.parseOnboardingId('102'), 102);
});

test('builds record-specific Stripe metadata', () => {
    const business = record(102, 'business', {});
    assert.deepEqual(
        app._test.buildVerificationMetadata(
            business, 'entity', 'rep-1', 'representative'
        ),
        {
            ownerSub: 'auth0|abc123',
            onboardingId: '102',
            onboardingType: 'business',
            target: 'entity',
            entityId: 'rep-1',
            entityKind: 'representative'
        }
    );
});

test('does not include entity metadata for a primary verification', () => {
    assert.deepEqual(
        app._test.buildVerificationMetadata(record(101, 'personal', {}), 'primary'),
        {
            ownerSub: 'auth0|abc123',
            onboardingId: '101',
            onboardingType: 'personal',
            target: 'primary'
        }
    );
});

test('accepts database personal and business types, not mismatched request types', () => {
    assert.equal(app._test.validateOnboardingType(record(101, 'personal', {}), 'personal'), 'personal');
    assert.equal(app._test.validateOnboardingType(record(102, 'business', {}), 'business'), 'business');
    assert.throws(
        () => app._test.validateOnboardingType(record(102, 'business', {}), 'personal'),
        { message: 'Onboarding type does not match the selected onboarding' }
    );
    assert.throws(
        () => app._test.validateOnboardingType(record(103, '', {}), 'business'),
        { message: 'Selected onboarding has an invalid onboarding type' }
    );
});

test('rejects a missing row or owner mismatch as not found', () => {
    assert.throws(
        () => app._test.assertRecordOwner(undefined, 'auth0|abc123'),
        { message: 'Onboarding record not found' }
    );
    assert.throws(
        () => app._test.assertRecordOwner(record(101, 'personal', {}), 'auth0|other'),
        { message: 'Onboarding record not found' }
    );
});

test('webhook persistence fetches and patches only the metadata onboarding ID', async () => {
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return {
            ok: true,
            json: async () => record(102, 'business', {}),
            text: async () => ''
        };
    };

    try {
        await app._test.fetchOnboardingRecord(102);
        await app._test.patchOnboardingRecord(102, 'auth0|abc123', { reviewDecision: 'Accepted' });
    } finally {
        global.fetch = originalFetch;
    }

    assert.deepEqual(requests.map(({ url }) => url), [
        'https://onboarding-backend-orcin.vercel.app/api/onboarding/102',
        'https://onboarding-backend-orcin.vercel.app/api/onboarding/102'
    ]);
    assert.equal(requests[1].options.method, 'PATCH');
    assert.equal(
        JSON.parse(requests[1].options.body).onboardingId,
        102
    );
});

test('updates only the selected record participant', () => {
    const personal101 = record(101, 'personal', { wizard: { personalAccountSelection: { coApplicants: [] } } });
    const business102 = record(102, 'business', {
        representatives: [{ id: 'rep-1', firstName: 'Jane', lastName: 'Doe' }],
        directors: [{ id: 'dir-1', firstName: 'Dan', lastName: 'Doe' }]
    });
    const business103 = record(103, 'business', { representatives: [{ id: 'rep-2' }] });
    const verification = { status: 'verified', report: reportFor('Jane', 'Doe') };

    const patch = app._test.buildEntityPatch(business102, 'rep-1', 'representative', verification);

    assert.equal(patch.representatives[0].identityVerificationComplete, true);
    assert.equal(patch.representatives[0].stripeVerification, verification);
    assert.equal(business102.data.directors[0].identityVerificationComplete, undefined);
    assert.equal(personal101.data.wizard.personalAccountSelection.coApplicants.length, 0);
    assert.equal(business103.data.representatives[0].identityVerificationComplete, undefined);
});

test('updates only the matching co-applicant in the selected record', () => {
    const selected = record(101, 'personal', {
        wizard: {
            personalAccountSelection: {
                coApplicants: [
                    { email: 'first@example.com', firstName: 'First', lastName: 'Applicant' },
                    { email: 'second@example.com', firstName: 'Second', lastName: 'Applicant' }
                ]
            }
        }
    });
    const untouched = record(103, 'business', { representatives: [{ id: 'rep-2' }] });
    const patch = app._test.buildCoApplicantPatch(selected, 'second@example.com', {
        status: 'verified', report: reportFor('Second', 'Applicant')
    });

    const applicants = patch.wizard.personalAccountSelection.coApplicants;
    assert.equal(applicants[0].identityVerificationComplete, undefined);
    assert.equal(applicants[1].identityVerificationComplete, true);
    assert.equal(untouched.data.representatives[0].identityVerificationComplete, undefined);
});

test('rejects an unknown entity in the selected record', () => {
    const business = record(102, 'business', { directors: [{ id: 'dir-1' }] });
    assert.throws(
        () => app._test.buildEntityPatch(business, 'missing', 'director', { status: 'verified' }),
        /No director found/
    );
});

test('does not approve business onboarding until every participant verifies', () => {
    const business = recordWith([]);
    business.data.wizard.personalAccountSelection = undefined;
    business.data.representatives = [verifiedApplicant('rep@example.com', 'Rep', 'Applicant')];
    business.data.directors = [{ id: 'dir-1', firstName: 'Director', lastName: 'Applicant' }];

    assert.equal(app._test.isReadyForApproval(business), false);

    business.data.directors[0] = {
        id: 'dir-1',
        ...verifiedApplicant('dir@example.com', 'Director', 'Applicant')
    };
    assert.equal(app._test.isReadyForApproval(business), true);
});
