<?php
/**
 * Countersign — Anthropic API proxy (PHP)
 * ----------------------------------------
 * Drop this file in the SAME directory as the Countersign HTML (e.g. public_html/rfp/).
 * The app's "Team server proxy" provider posts Anthropic-format requests here;
 * this script attaches the API key server-side and forwards them. Users never see the key.
 *
 * Setup:
 *   1. Set the key: EITHER export ANTHROPIC_API_KEY in your hosting panel,
 *      OR paste it into $API_KEY below (then keep this file out of git!).
 *   2. (Recommended) Set $TEAM_TOKEN to a shared passphrase; team members enter it
 *      in the app's AI settings so random visitors can't spend your credits.
 *   3. In the app: AI settings -> "Team server proxy", URL: proxy.php
 */

// ---------------- configuration ----------------
$API_KEY        = getenv('ANTHROPIC_API_KEY') ?: 'sk-ant-REPLACE_ME';
$TEAM_TOKEN     = getenv('COUNTERSIGN_TOKEN') ?: '';       // '' = disabled (not recommended on public URLs)
$ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
$DEFAULT_MODEL  = 'claude-sonnet-4-6';
$MAX_TOKENS_CAP = 1024;      // hard ceiling regardless of what the client asks for
$MAX_BODY_BYTES = 400000;    // ~400 KB — plenty for prompt + retrieved context
// ------------------------------------------------

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => ['type' => 'proxy_error', 'message' => $msg]]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST only');
if (strpos($API_KEY, 'REPLACE_ME') !== false) fail(500, 'Server not configured: set ANTHROPIC_API_KEY');

if ($TEAM_TOKEN !== '') {
    $sent = $_SERVER['HTTP_X_TEAM_TOKEN'] ?? '';
    if (!hash_equals($TEAM_TOKEN, $sent)) fail(401, 'Missing or wrong team token');
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) === 0) fail(400, 'Empty body');
if (strlen($raw) > $MAX_BODY_BYTES)       fail(413, 'Request too large');

$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['messages']) || !is_array($body['messages']))
    fail(400, 'Body must be Anthropic /v1/messages JSON');

// Enforce server-side limits: model allowlist + token cap. Strip anything else exotic.
$model = in_array($body['model'] ?? '', $ALLOWED_MODELS, true) ? $body['model'] : $DEFAULT_MODEL;
$payload = [
    'model'      => $model,
    'max_tokens' => min((int)($body['max_tokens'] ?? $MAX_TOKENS_CAP), $MAX_TOKENS_CAP),
    'messages'   => $body['messages'],
];
if (isset($body['system']) && is_string($body['system'])) $payload['system'] = $body['system'];

$ch = curl_init('https://api.anthropic.com/v1/messages');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode($payload),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 120,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'x-api-key: ' . $API_KEY,
        'anthropic-version: 2023-06-01',
    ],
]);
$response = curl_exec($ch);
if ($response === false) {
    $err = curl_error($ch);
    curl_close($ch);
    fail(502, 'Upstream request failed: ' . $err);
}
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

http_response_code($status);
echo $response;
