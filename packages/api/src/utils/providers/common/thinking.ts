import { BadRequestException } from "sonamu";

import { SD } from "../../../i18n/sd.generated";

export class ThinkingValidationError extends BadRequestException {
  constructor(message: string) {
    super(SD("error.detail")(message));
    this.name = "ThinkingValidationError";
  }
}
