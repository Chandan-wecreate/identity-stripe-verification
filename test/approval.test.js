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
