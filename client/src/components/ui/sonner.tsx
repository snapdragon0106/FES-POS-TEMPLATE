import { useTheme } from "@/contexts/ThemeContext";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // This app never defined shadcn's --popover/--border tokens, so these
      // resolved to nothing and every toast rendered with a transparent
      // background — its text printed straight over whatever was behind it.
      style={
        {
          "--normal-bg": "var(--ws-toast-bg)",
          "--normal-text": "var(--ws-tx)",
          "--normal-border": "var(--ws-toast-bd)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
