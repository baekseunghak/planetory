// Keep scientific time and activity timestamps distinct at component boundaries.
export type Btjd = number & { readonly __unit: "BTJD" };
export type UtcTimestamp = string & { readonly __unit: "UTC" };
export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
};
