import {
  type Materials,
  sameMaterials,
  changedMaterials,
} from "./materialContracts";
import { ApiError } from "../../api/client";
import { readPost } from "./contracts";

export const postTags = {
  ANALYSIS: "분석 이야기",
  QUESTION: "질문",
  DISCUSSION: "토론",
  INFORMATION: "정보",
  GENERAL: "자유 이야기",
} as const;
export type PostTag = keyof typeof postTags;
export type PostDraft = Materials & {
  title: string;
  body: string;
  purposeTag: string;
  ticId: string;
  board: "FREE" | "STAR";
};
export type PostValues = Materials & {
  title: string;
  body: string;
  purposeTag: string;
  ticId: string | null;
};
export type PostField = "title" | "body" | "purposeTag" | "ticId";
export type PostErrors = Partial<Record<PostField, string>>;
// Match Java Character.isWhitespace / String.strip used by PostService.
// NBSP, figure space, narrow NBSP and BOM are not Java whitespace.
const javaSpace =
  "[\\u0009-\\u000d\\u001c-\\u0020\\u1680\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000]";
export const stripTitle = (value: string) =>
  value.replace(new RegExp(`^${javaSpace}+|${javaSpace}+$`, "g"), "");
export const codePoints = (value: string) => Array.from(value).length;
export function postValues(draft: PostDraft): PostValues {
  return {
    ...(draft.historyIds ? { historyIds: draft.historyIds } : {}),
    ...(draft.sourceLinks ? { sourceLinks: draft.sourceLinks } : {}),
    title: stripTitle(draft.title),
    body: draft.body,
    purposeTag: draft.purposeTag,
    ticId: draft.board === "FREE" ? null : draft.ticId,
  };
}
export function validatePost(draft: PostDraft): PostErrors {
  const values = postValues(draft),
    errors: PostErrors = {};
  if (
    !values.title ||
    /[\n\r\u0085\u2028\u2029]/.test(values.title) ||
    codePoints(values.title) > 100
  )
    errors.title = "제목은 줄바꿈 없이 1~100자로 입력해 주세요.";
  if (
    !draft.body ||
    new RegExp(`^${javaSpace}*$`).test(draft.body) ||
    codePoints(draft.body) > 10_000
  )
    errors.body = "본문은 공백만 입력할 수 없으며 1~10,000자로 입력해 주세요.";
  if (!Object.hasOwn(postTags, draft.purposeTag))
    errors.purposeTag = "글 종류를 선택해 주세요.";
  if (
    values.ticId !== null &&
    (!/^[1-9]\d*$/.test(values.ticId) ||
      values.ticId.length > 19 ||
      BigInt(values.ticId) > 9223372036854775807n)
  )
    errors.ticId = "연결할 별의 TIC 번호를 양의 정수로 입력해 주세요.";
  return errors;
}
export function changedPostFields(
  original: PostValues,
  draft: PostDraft,
): Partial<PostValues> {
  const values = postValues(draft),
    patch: Partial<PostValues> = {};
  for (const key of ["title", "body", "purposeTag", "ticId"] as const)
    if (original[key] !== values[key])
      Object.assign(patch, { [key]: values[key] });
  Object.assign(patch, changedMaterials(original, draft));
  return patch;
}
export function patchIsVisible(post: PostValues, sent: Partial<PostValues>) {
  const { historyIds, sourceLinks, ...fields } = sent;
  return (
    Object.entries(fields).every(
      ([key, value]) => post[key as keyof PostValues] === value,
    ) &&
    (!Object.hasOwn(sent, "historyIds") ||
      sameMaterials({ historyIds: post.historyIds }, { historyIds })) &&
    (!Object.hasOwn(sent, "sourceLinks") ||
      sameMaterials(
        {
          sourceLinks: post.sourceLinks,
          unavailableSources: post.unavailableSources,
        },
        { sourceLinks },
      ))
  );
}
export function toDraft(post: PostValues): PostDraft {
  return {
    ...post,
    ticId: post.ticId ?? "",
    board: post.ticId === null ? "FREE" : "STAR",
  };
}
export function readEditablePost(value: unknown) {
  const post = readPost(value);
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.attachments) || !Array.isArray(row.sourceLinks))
    throw new ApiError(
      0,
      "INVALID_RESPONSE",
      "글의 자료 연결 상태를 확인할 수 없습니다.",
    );
  return {
    ...post,
    hasAttachments: row.attachments.length > 0 || row.sourceLinks.length > 0,
  };
}
export type EditablePost = ReturnType<typeof readEditablePost>;
export function readCreatedPost(value: unknown): {
  postId: string;
  createdAt: string;
} {
  const row = value as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.postId !== "string" ||
    !row.postId.trim() ||
    typeof row.createdAt !== "string" ||
    !/T.*(?:Z|\+00:00)$/.test(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    throw new ApiError(
      0,
      "INVALID_RESPONSE",
      "게시 응답을 확인할 수 없습니다. 목록에서 저장 여부를 확인해 주세요.",
      [],
      null,
      null,
      true,
    );
  return { postId: row.postId, createdAt: row.createdAt };
}
