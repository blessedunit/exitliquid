import { permanentRedirect } from "next/navigation";

// /how-it-works was folded into the one reference page.
export default function HowItWorksRedirect() {
  permanentRedirect("/methodology");
}
