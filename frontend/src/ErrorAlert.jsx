import { useEffect, useRef } from "react";
import Icon from "./Icon.jsx";

// An error next to the control that caused it, scrolled into view so it is not missed below the fold.
export default function ErrorAlert({ message, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [message]);
  if (!message) return null;
  return <div ref={ref} className={`alert error-alert ${className}`.trim()} role="alert"><Icon name="close" size={16} /><span>{message}</span></div>;
}
