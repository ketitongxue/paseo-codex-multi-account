// Standalone preview adapters, not a second implementation of the account screen.
// All account/usage UI is rendered from client/accounts.tsx; mutating actions are disabled.
import { createElement, Fragment } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { snapshot, usage } from "./data";

export { ScrollView, TextInput };
export function useRpc(contract) {
  return async () => {
    if (contract.name === "accounts.list") return snapshot;
    if (contract.name === "usage.list") return usage;
    throw new Error("This is a read-only preview with synthetic data.");
  };
}
export function usePaseo() {
  return {
    agents: {
      create: async () => {
        throw new Error("Agent creation is disabled in the preview.");
      },
    },
  };
}
export const Modal = Object.assign(
  ({ open, children }) => (open ? createElement(View, null, children) : null),
  { Content: ({ children }) => createElement(Fragment, null, children) },
);
export function ExternalLink({ children }) {
  return createElement(Fragment, null, children);
}
export async function copyText() {
  throw new Error("Clipboard access is disabled in the preview.");
}
