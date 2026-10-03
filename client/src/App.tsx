import { Toaster } from "@/components/ui/sonner";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import POSApp from "./pages/POSApp";

// No 合言葉 or login screen in here: the server only sends this app to a
// logged-in browser and serves its own 合言葉 / login pages otherwise
// (server/gate.ts, server/login.ts). Every path is the register itself.
function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        {/* Top, not sonner's default bottom: on a phone the bottom is
            where the checkout sheet's 確定 button and the tab bar live,
            and the one toast that most needs acting on ("通信が途切れま
            した…もう一度「会計を確定する」を押して") would sit on top of
            the very button it tells the cashier to press. */}
        <Toaster position="top-center" />
        <POSApp />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
