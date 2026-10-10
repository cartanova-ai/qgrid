import { BadRequestException } from "sonamu";

import { type LocalizedString } from "../../../i18n/sd.generated";

export class ThinkingValidationError extends BadRequestException {
  constructor(message: string) {
    super(message as LocalizedString);
    this.name = "ThinkingValidationError";
  }
}
