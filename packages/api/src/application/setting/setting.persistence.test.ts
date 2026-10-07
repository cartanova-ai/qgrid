import { randomUUID } from "node:crypto";

import { Sonamu } from "sonamu";
import { beforeAll, expect, it } from "vitest";

import { SettingModel } from "./setting.model";

beforeAll(async () => {
  await Sonamu.initForTesting();
});

it("atomically saves concurrent first writes to the same setting key", async () => {
  const key = `test.concurrent.${randomUUID()}`;
  try {
    await Promise.all([SettingModel.setByKey(key, "first"), SettingModel.setByKey(key, "second")]);
    const { rows } = await SettingModel.findMany("A", { key, num: 0, page: 1 });
    expect(rows).toHaveLength(1);
    expect(["first", "second"]).toContain(rows[0]!.value);
    await SettingModel.setByKey(key, "final");
    await expect(SettingModel.findOne("A", { key })).resolves.toMatchObject({
      id: rows[0]!.id,
      value: "final",
    });
  } finally {
    await SettingModel.clearByKey(key);
  }
});
