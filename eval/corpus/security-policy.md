# Northwind Software: Information Security Policy (v4.2)

## Certifications and audits
Northwind Software maintains ISO 27001:2022 certification (certificate NW-27001-2024,
issued by BSI, valid through March 2027) and completes an annual SOC 2 Type II audit
covering Security, Availability and Confidentiality. The most recent SOC 2 Type II report
covers the period 1 April 2025 to 31 March 2026 and is available under NDA.

## Encryption
All customer data is encrypted at rest using AES-256-GCM. Encryption keys are managed in
AWS KMS with automatic annual key rotation; customer-managed keys (BYOK) are available on
the Enterprise plan. Data in transit is protected with TLS 1.3 (TLS 1.2 minimum for legacy
clients). We disable all cipher suites below 128-bit and do not support SSLv3, TLS 1.0 or
TLS 1.1.

## Authentication and single sign-on
The platform supports SAML 2.0 single sign-on with Okta, Microsoft Entra ID (Azure AD),
Google Workspace and OneLogin, plus OpenID Connect for custom identity providers.
SCIM 2.0 user provisioning and de-provisioning is supported for Okta and Entra ID.
Multi-factor authentication is enforced for all administrative accounts; TOTP and WebAuthn
hardware keys are both supported. Password accounts require 12 characters minimum and are
hashed with Argon2id.

## Access control and audit logging
Role-based access control ships with five built-in roles (Owner, Admin, Editor, Viewer,
Auditor) and supports custom roles on the Enterprise plan. Every administrative and
data-access event is written to an immutable audit log retained for 400 days. The log is
exportable via API or streamed to a customer SIEM over webhook or to an Amazon S3 bucket.

## Penetration testing and vulnerability management
An independent third-party penetration test is performed annually by Cure53; the executive
summary is shared with customers on request. We run continuous dependency scanning
(Dependabot and Snyk) and static analysis on every pull request. Critical vulnerabilities
are remediated within 7 days, high within 30 days and medium within 90 days.
