import { permanentRedirect } from "next/navigation";

// Devs are wallets: one search, one profile per address.
export default function DevIndexRedirect() {
  permanentRedirect("/w");
}
