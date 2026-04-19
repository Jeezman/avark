import { useEffect, useState } from "react";

// On iOS WKWebView the on-screen keyboard shrinks the visual viewport but
// leaves the layout viewport (what `position: fixed` anchors to) unchanged,
// so `bottom: 0` sheets end up hidden behind the keyboard. This returns the
// keyboard height so callers can add it as a `bottom` offset to pin above.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
