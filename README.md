# identity-stripe-verification

When Stripe sends `identity.verification_session.verified` to `/webhook`, the
server retrieves its verification report, PATCHes the matching onboarding record,
and emits a Pusher notification as `my-channel` / `verification-report`.

Create a session with the owner ID and the specific onboarding record ID:

```json
{
  "ownerSub": "auth0|abc123",
  "onboardingId": 102,
  "target": "primary"
}
```

The webhook updates only that onboarding record. For joint applicants and
business entities, include `target`, `entityId`, and `entityKind` as required.
