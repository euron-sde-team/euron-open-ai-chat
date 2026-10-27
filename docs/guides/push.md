# Push notifications

How to let the native apps say "your answer is ready" when someone leaves an answer
running in the background. Push is off by default. The web app never causes a push.

The design is in [ADR 0015](../architecture/adr/0015-push-opt-in-per-answer.md); the client
side is in [mobile-clients.md](mobile-clients.md#push-notifications). The mobile app is
`euron-open-ai-chat-app` (being built); its own docs cover the Firebase files that go
inside the app.

## How it works

1. After sign-in, the app registers its Firebase Cloud Messaging (FCM) token with
   `PUT /api/me/devices`. A device row alone never causes a notification.
2. When the app goes to the background while an answer is still being written, it calls
   `POST /api/turns/:id/notify` for that answer. The server notes it in Redis.
3. When the answer ends, the worker sends one message per device of that user and deletes
   tokens FCM reports as dead.

The notification says the app name and "Your answer is ready." (or "Your answer could not
be finished."). It carries `type: "turn"`, `conversationId` and `messageId` as data, so a
tap opens the chat. A cancelled answer sends nothing.

FCM delivers to Android directly and to iPhones through Apple's push service (APNs). The
APNs key goes into the Firebase project, never onto this server. The server holds one
credential: a Firebase service account key.

## Turn it on

### 1. Create a Firebase project

1. Open the Firebase console and create a project, for example `my-chat-app`. Analytics is
   not needed.
2. Add an **Android** app with the app's package name (for example
   `com.example.chat`). Firebase gives you `google-services.json` for the app build.
3. Add an **iOS** app with the app's bundle id (for example `com.example.chat`). Firebase
   gives you `GoogleService-Info.plist` for the app build.

Both files belong to the app, not to this server. See the `euron-open-ai-chat-app` docs for
where they go.

### 2. Upload the APNs key (iPhones)

1. In the Apple Developer account, under Certificates, Identifiers and Profiles, Keys,
   create a key with **Apple Push Notifications service (APNs)** enabled. Download the
   `.p8` file once and note its Key ID and your Team ID.
2. In Firebase, Project settings, Cloud Messaging, Apple app configuration, upload the
   `.p8` file with the Key ID and Team ID.

Without this step Android receives pushes and iPhones do not; FCM accepts the message
either way.

### 3. Create a service account key

1. In Firebase, Project settings, Service accounts, or in the Google Cloud console for the
   same project, under IAM, Service accounts, create a service account, for example
   `push@my-chat-app.iam.gserviceaccount.example.com`.
2. Give it the **Firebase Cloud Messaging API Admin** role (sending is all it needs; do not
   use the Owner or Editor role).
3. Make sure the **Firebase Cloud Messaging API (V1)** is enabled for the project.
4. Create a JSON key for the service account and download it. It holds `project_id`,
   `client_email` and `private_key`, which is all the server reads.

Treat the key file as a secret. Do not commit it, paste it into a ticket or put it in a
plain environment file that is shared.

### 4. Configure the server

| Variable | Value |
| --- | --- |
| `PUSH_PROVIDER` | `fcm` |
| `FCM_SERVICE_ACCOUNT_JSON` | The whole key file as one string. On AWS, a secret |
| `PUSH_PREVIEW` | `false` (default). See [Previews](#previews) |

The API and the worker both need them: the API answers `notify` and reports
`features.push`, the worker sends.

**Local compose** (`deploy/compose/.env`, git-ignored). The key file on one line, in single
quotes:

```bash
jq -c . service-account.json   # prints the key file on one line
```

```bash
PUSH_PROVIDER=fcm
FCM_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"my-chat-app","client_email":"push@my-chat-app.iam.gserviceaccount.example.com","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}'
```

**AWS with Terraform.** Set `push_provider = "fcm"` in `terraform.tfvars` and apply. That
creates the secret `<name_prefix>/push` holding `set-me` and injects it into the api and
worker as `FCM_SERVICE_ACCOUNT_JSON`. Put the key file in it, then roll the services:

```bash
aws secretsmanager put-secret-value --secret-id <name_prefix>/push \
  --secret-string file://service-account.json
make aws-deploy ENV=aws-dev
```

`terraform output push_secret_name` prints the secret's name. `push_preview = true` sets
`PUSH_PREVIEW`. You can also pass `fcm_service_account_json`, but the key then lands in
Terraform state.

At boot, `PUSH_PROVIDER=fcm` with a missing or unparseable key logs the warning
`PUSH_PROVIDER=fcm but FCM_SERVICE_ACCOUNT_JSON is missing or invalid: push is off`, and
the server runs without push.

### 5. Check it

```bash
curl -s https://chat.example.com/api/meta | jq .features.push   # true
```

Then, in the app: sign in, allow notifications, send a long question, and put the app in
the background before the answer finishes.

## Previews

With `PUSH_PREVIEW=true` the notification title is the chat title and the body is the
first 120 characters of the answer. It is off by default because notification text passes
through Google and Apple and shows on a locked screen, where anyone holding the phone can
read it. That would break the rule that conversation text stays in the database
([ADR 0012](../architecture/adr/0012-no-conversation-text-in-logs.md)). Turn it on only if
your users accept that.

## Try it locally without Firebase

`PUSH_PROVIDER=stub` runs the real FCM client (JWT signing, the token exchange, the send
call, dead-token handling) against [`apps/stubs`](../../apps/stubs/README.md), with a
throwaway key generated at boot. The stubs record every message. Production refuses
`stub`.

```bash
# deploy/compose/.env
PUSH_PROVIDER=stub
```

`make up` again, then with a native session (an `accessToken` from
`POST /api/auth/login` with `X-Client: native`):

```bash
API=http://localhost:5036/api
AUTH="Authorization: Bearer $ACCESS_TOKEN"

# register a device
curl -s -X PUT "$API/me/devices" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"platform":"ANDROID","token":"local-test-token","appVersion":"1.0.0"}'

# start a slow answer (the stub model streams slowly on the word "slow")
curl -s -X POST "$API/chats/new/messages" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"content":"slow please"}'          # note assistantMessageId

# arm it while it is still being written
curl -s -X POST "$API/turns/$ASSISTANT_MESSAGE_ID/notify" -H "$AUTH"   # {"state":"armed"}

# a few seconds later, what FCM would have delivered
curl -s "http://localhost:5129/fcm/messages?token=local-test-token" | jq
```

The stubs are at `{STUBS_URL}`, `http://localhost:5129` from the host. `POST /fcm/reset`
clears the record. Device tokens starting with `dead` answer `UNREGISTERED` and tokens
starting with `bad` answer `INVALID_ARGUMENT`, so you can watch the server delete them.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `GET /api/meta` shows `features.push: false` | `PUSH_PROVIDER` is `none`, or `fcm` with a missing or invalid `FCM_SERVICE_ACCOUNT_JSON`. Look for the boot warning. The JSON must have `project_id`, `client_email` and `private_key`; `set-me` counts as not set |
| `POST /api/turns/:id/notify` answers `409 PUSH_DISABLED` | Same cause: the server has no working push provider. The app should check `features.push` first |
| `notify` answers `{ "state": "finished" }` | The answer ended before the app asked. Nothing is sent; the app follows the turn instead |
| `notify` answers `404 TURN_NOT_FOUND` | The id is not an assistant message of the signed-in user. Use `assistantMessageId` (the `turnId`) |
| Android receives, iPhones do not | The APNs key is not uploaded to Firebase, or the iOS app's bundle id differs from the Firebase iOS app |
| Nothing arrives, worker logs `push not delivered` | A transient FCM error (429, 5xx, network) for that message; it is not retried. Check the worker can reach `fcm.googleapis.com` and `oauth2.googleapis.com` on 443 |
| Worker job `push.turn-ready` fails with `PUSH_AUTH_FAILED` | Google refused the service account: the key was deleted or rotated, the role is missing, or the FCM API is disabled for the project. The job is retried (5 attempts with backoff), then dropped |
| A device stops being listed | FCM reported its token as dead (`UNREGISTERED` or `INVALID_ARGUMENT`: the app was uninstalled or the token rotated) and the server deleted it. The app registers its new token on the next launch |
| A user gets no push after signing in on a shared phone | A token belongs to one account at a time: the last account to register it gets the pushes |
| Devices gone after a password change | Ending every session (sign out everywhere, password change or reset, ban, deletion) removes the account's devices. The app registers again after sign-in |
