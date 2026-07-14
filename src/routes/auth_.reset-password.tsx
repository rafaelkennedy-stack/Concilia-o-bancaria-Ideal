import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { MailCheck } from "lucide-react";
import { PASSWORD_RESET_REDIRECT } from "@/lib/auth-urls";

// Rota "auth_" (com underscore) = NÃO aninha dentro de auth.tsx, que é uma folha
// sem <Outlet/>. A URL continua sendo /auth/reset-password.
export const Route = createFileRoute("/auth_/reset-password")({
  component: ResetPassword,
});

function ResetPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [enviado, setEnviado] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: PASSWORD_RESET_REDIRECT,
    });
    setBusy(false);
    if (error) {
      toast.error("Não foi possível enviar o link", { description: error.message });
      return;
    }
    // Sucesso é mostrado mesmo se o email não existir: dizer "email não cadastrado"
    // permitiria descobrir quem tem conta no sistema.
    setEnviado(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Recuperar senha</CardTitle>
          <CardDescription>
            {enviado
              ? "Se o email estiver cadastrado, o link de recuperação chegará em instantes."
              : "Enviaremos um link para você definir uma nova senha."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {enviado ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200">
                <MailCheck className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <div className="font-medium">Link enviado para {email}</div>
                  <p className="mt-1">
                    Abra o email e clique no link para definir a nova senha. Ele vale por tempo
                    limitado — se expirar, é só pedir outro aqui.
                  </p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={() => setEnviado(false)}>
                Enviar para outro email
              </Button>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={submit}>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email" type="email" value={email} autoComplete="email" required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy || !email}>
                {busy ? "Enviando…" : "Enviar link de recuperação"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-center text-xs text-muted-foreground">
            <Link to="/auth" className="hover:underline">← voltar para o login</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
