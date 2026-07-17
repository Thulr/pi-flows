# Signing-key policy

- Rotations require a 48-hour overlap.
- During overlap, the old key remains verify-only after all signers receive the new key.
- Revocation requires Security approval.
- A key may be revoked only after every production region signs at least 99.9% of requests with the new key for six continuous hours.
