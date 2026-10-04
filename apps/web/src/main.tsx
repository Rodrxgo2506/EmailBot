import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { envError } from "./lib/env";
import "./index.css";

function ConfigurationError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-sm">
        <h1 className="mb-2 text-base font-semibold">Configuración incompleta</h1>
        <p>{message}</p>
        <p className="mt-2 text-muted-foreground">
          Define VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y VITE_API_URL en el archivo .env de la raíz.
        </p>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{envError ? <ConfigurationError message={envError} /> : <App />}</StrictMode>);
}
