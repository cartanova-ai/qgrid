
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingModel } from "./setting.model";
import * as reminders from "../qgrid/expired-token-reminder";
import { SlackNotificationError } from "../../utils/slack-notify";

describe("SettingModel.triggerExpiryReminder", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the sent count after successful delivery", async () => {
    vi.spyOn(reminders, "sendExpiredTokenReminderNow").mockResolvedValue(3);
    await expect(SettingModel.triggerExpiryReminder()).resolves.toEqual({ sent: 3 });
  });

  it("returns a readable API error when Slack rejects a manual send", async () => {
    vi.spyOn(reminders, "sendExpiredTokenReminderNow").mockRejectedValue(
      new SlackNotificationError("Slack 알림 발송 실패: not_in_channel"),
    );
    await expect(SettingModel.triggerExpiryReminder()).rejects.toMatchObject({
      statusCode: 400, message: "Slack 알림 발송 실패: not_in_channel",
    });
  });
});
