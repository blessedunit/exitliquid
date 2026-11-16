import { permanentRedirect } from "next/navigation";

// The Hall of Exits is a block at the bottom of the $EXIT page.
export default function HallRedirect() {
  permanentRedirect("/exit#hall");
}
