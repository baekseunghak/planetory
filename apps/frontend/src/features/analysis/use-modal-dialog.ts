import { useEffect, useRef, type RefObject } from "react";

/**
 * 네이티브 `<dialog>`를 React 상태에 맞춰 여닫는다. 포커스 가둠·Escape·배경
 * 비활성은 브라우저가 처리하고, 여기서는 세 가지만 책임진다.
 *
 * 1. **닫힘을 네이티브로 받는다.** React의 `onClose`·`onCancel`은 이 대화상자에서
 *    발화하지 않는다. `<form method="dialog">` 제출이나 Escape로 브라우저가 먼저
 *    닫으면 상태는 열린 채로 남아, 화면에는 아무것도 없는데 다시 열리지도 않는다.
 * 2. **요소는 항상 그려 둔다.** 열릴 때만 그리면 리스너를 붙이는 시점에 ref가
 *    비어 있어 Escape가 영영 동작하지 않는다. 닫힌 `<dialog>`는 보이지 않으므로
 *    계속 두어도 된다. 호출부가 내용만 비우면 된다.
 * 3. **닫은 뒤 포커스를 갈 곳에 돌려준다.** 연 버튼이 그사이 비활성이 되면
 *    포커스가 문서 맨 위로 떨어진다.
 */
export function useModalDialog({
  open,
  onClose,
  fallbackRef,
}: {
  open: boolean;
  /** 브라우저가 닫았을 때 상태를 맞춘다. Escape도 여기로 온다. */
  onClose: () => void;
  /** 닫은 뒤 포커스를 받을 곳. 연 버튼이 포커스를 받을 수 없을 때 쓴다. */
  fallbackRef?: RefObject<HTMLElement | null>;
}): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // node.open으로 판단하면 브라우저가 먼저 닫은 경우를 놓친다.
  const wasOpen = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      closeRef.current();
    };
    const closed = () => closeRef.current();
    node.addEventListener("cancel", cancel);
    node.addEventListener("close", closed);
    return () => {
      node.removeEventListener("cancel", cancel);
      node.removeEventListener("close", closed);
    };
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open) {
      if (!node.open) {
        opener.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        node.showModal();
      }
    } else if (wasOpen.current) {
      if (node.open) node.close();
      const back = opener.current;
      (fallbackRef?.current ??
        (back && !back.hasAttribute("disabled") ? back : null))?.focus();
    }
    wasOpen.current = open;
  }, [open, fallbackRef]);

  return ref;
}
