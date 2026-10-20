import { Sonamu } from "sonamu";

import { runRequiredMigrations } from "./startup-migrations";

type BootstrapSteps = {
  init: () => Promise<void>;
  migrate: () => Promise<void>;
  listen: () => Promise<void>;
};

export async function bootstrapServer(
  steps: BootstrapSteps = {
    init: () => Sonamu.init(),
    migrate: runRequiredMigrations,
    listen: async () => {
      await Sonamu.createServer();
    },
  },
): Promise<void> {
  await steps.init();
  await steps.migrate();
  await steps.listen();
}
