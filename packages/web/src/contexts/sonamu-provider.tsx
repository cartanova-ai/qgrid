import { SonamuProvider as BaseSonamuProvider } from "@sonamu-kit/react-components";
import { type ReactNode } from "react";

import { type DictKey, type MergedDictionary } from "@/i18n/sd.generated";
import { SD } from "@/i18n/sd.generated";

const sd = <K extends DictKey>(key: K): ReturnType<typeof SD<K>> => SD(key);

export function SonamuProvider({ children }: { children: ReactNode }) {
  return <BaseSonamuProvider<MergedDictionary> SD={sd}>{children}</BaseSonamuProvider>;
}
