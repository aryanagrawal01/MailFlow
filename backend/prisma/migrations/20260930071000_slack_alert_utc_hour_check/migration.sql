-- SlackAlert.hourWindowStart is the UTC-hour bucket key. Enforce hour
-- alignment so the unique (user_id, hour_window_start) index means one alert
-- per user per UTC hour even when rows are inserted outside application code.
ALTER TABLE "slack_alerts"
ADD CONSTRAINT "slack_alerts_hour_window_start_utc_hour_check"
CHECK (
    date_trunc('hour', "hour_window_start" AT TIME ZONE 'UTC')
    = "hour_window_start" AT TIME ZONE 'UTC'
);
