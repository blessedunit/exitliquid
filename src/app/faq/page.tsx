import { permanentRedirect } from "next/navigation";

// /faq was folded into the one reference page.
export default function FaqRedirect() {
  permanentRedirect("/methodology");
}
