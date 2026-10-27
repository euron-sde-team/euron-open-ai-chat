-- Push notifications for the native apps.
--
--   push_devices   one row per installed app that may be told "your answer is ready"
--
-- Nothing is pushed unless the app asks for it on a specific answer
-- (POST /api/turns/:id/notify, sent when the app goes to the background mid-answer),
-- so a device row alone never causes a notification.

-- A token belongs to exactly one account at a time: signing in on a device that someone
-- else used re-assigns the row (services/push.service.ts). Ending every session of an
-- account (sign out everywhere, password change or reset, ban, deletion) removes its
-- devices too (repositories/session.repository.ts revokeAllForUser).
CREATE TABLE push_devices (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('IOS', 'ANDROID')),
  token        text NOT NULL UNIQUE CHECK (length(token) BETWEEN 1 AND 4096),
  app_version  text CHECK (length(app_version) <= 40),
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX push_devices_user_idx ON push_devices (user_id);
