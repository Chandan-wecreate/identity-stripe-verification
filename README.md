# identity-stripe-verification

When Stripe sends `identity.verification_session.verified` to `/webhook`, the
server retrieves its verification report, PATCHes the matching onboarding record,
and emits a Pusher notification as `my-channel` / `verification-report`.

Create a session with the onboarding owner ID:

```json
{ "ownerSub": "sms|6a3366b685cffee1d8cf12f8" }
```

The webhook saves the result in `wizard.stripeVerification` and sets
`wizard.identityVerificationComplete` to `true`.
