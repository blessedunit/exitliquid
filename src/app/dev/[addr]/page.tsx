import { permanentRedirect } from "next/navigation";

// The dev passport is the "Launches created" block of the wallet profile: one page per address.
export default async function DevRedirect({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  permanentRedirect(/^0x[0-9a-fA-F]{40}$/.test(addr) ? `/w/${addr.toLowerCase()}#launches` : "/w");
}
