# Northwind Platform: API and Integrations

## REST API
A documented REST API covers 100% of the functionality available in the user interface.
Requests are authenticated with OAuth 2.0 client credentials or with scoped personal access
tokens. Rate limits are 1,000 requests per minute per tenant on the Professional plan and
5,000 requests per minute on the Enterprise plan. An OpenAPI 3.1 specification is published
and client SDKs are maintained for Python, TypeScript, Java and Go.

## Webhooks
Outbound webhooks are available for 40 event types. Every delivery is signed with an
HMAC-SHA256 signature over the request body so the receiver can verify authenticity, and
failed deliveries are retried with exponential backoff for up to 24 hours.

## Native integrations
Native, supported integrations ship for Salesforce, HubSpot, Slack, Microsoft Teams, Jira
and ServiceNow. Each integration is configured from the administration console without
custom code.

## Sandbox environments
The Professional and Enterprise plans include a sandbox environment at no additional charge
for integration development and user acceptance testing. Sandbox data is isolated from
production and can be reset on demand.
