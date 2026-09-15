import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { subscribeSkyChange } from "./events";
import { SkyDataStore } from "./store";
const empty = new SkyDataStore(async () => undefined, "").getSnapshot();
const noSubscribe = () => () => {};
const getEmpty = () => empty;
export function useSkyData() {
  const { member } = useSession();
  const [store, setStore] = useState<SkyDataStore | null>(null);
  useEffect(() => {
    if (!member) return;
    const next = new SkyDataStore(api, member.memberId);
    setStore(next);
    const off = subscribeSkyChange(member.memberId, (event) => {
      void next.notifySkyChanged(event);
    });
    void next.refresh();
    return () => {
      off();
      next.dispose();
    };
  }, [member?.memberId]);
  const activeStore =
    member && store?.memberId === member.memberId ? store : null;
  return {
    store: activeStore,
    data: useSyncExternalStore(
      activeStore?.subscribe || noSubscribe,
      activeStore?.getSnapshot || getEmpty,
    ),
  };
}
