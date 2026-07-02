export type RoomType = "MDF" | "IDF" | "other";

export const ROOM_TYPES: RoomType[] = ["MDF", "IDF", "other"];

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function isValidRackHeight(u: number): boolean {
  return Number.isInteger(u) && u > 0 && u <= 60;
}
