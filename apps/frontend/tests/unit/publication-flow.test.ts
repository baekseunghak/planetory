import assert from "node:assert/strict";
import { test } from "node:test";
import { publicationDetail, PUBLICATION_TIC } from "../../dev/publication-fixtures";
import { readPreview } from "../../src/features/publication/publication-data";
import { allPublished, publicationNotice } from "../../src/features/publication/publication-flow";
import type { ReviewItem } from "../../src/features/publication/use-publication";

test("completion requires verified publication of every item and exhausted pages", () => {
  const preview = readPreview(publicationDetail("h-1951"), "h-1951", PUBLICATION_TIC, "c-1951");
  preview.detail.explanation.publication.state = "PUBLISHED";
  const item: ReviewItem = {historyId:"h-1951", selected:false, loading:false, preview, outcome:"received"};
  const review = {items:[item], loading:false, busy:false, cursor:null};
  assert.equal(allPublished(review), true);
  assert.equal(publicationNotice(item), "게시가 완료되었습니다.");
  for (const change of [{stale:true}, {loading:true}, {error:"조회 실패"}]) {
    const pending = {...item, ...change};
    assert.equal(allPublished({...review, items:[pending]}), false);
    assert.notEqual(publicationNotice(pending), "게시가 완료되었습니다.");
  }
  assert.equal(allPublished({...review, cursor:"next"}), false);
  assert.equal(allPublished({...review, items:[]}), false);
  assert.equal(allPublished({...review, busy:true}), false);
  const unpublished = {...item, preview:readPreview(publicationDetail("h-1951"), "h-1951", PUBLICATION_TIC, "c-1951")};
  assert.equal(allPublished({...review, items:[item, unpublished]}), false);
});
