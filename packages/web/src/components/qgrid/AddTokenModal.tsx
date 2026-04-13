import { Input } from "@sonamu-kit/react-components/components";
import { useTypeForm } from "@sonamu-kit/react-components/lib";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import EyeIcon from "~icons/lucide/eye";
import EyeOffIcon from "~icons/lucide/eye-off";
import KeyIcon from "~icons/lucide/key-round";
import PlusIcon from "~icons/lucide/plus";

import { QgridService } from "@/services/services.generated";
import { TokenSaveParams } from "@/services/token/token.types";

export function AddTokenModal() {
  const [open, setOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);

  const { form, register, reset } = useTypeForm(TokenSaveParams, {
    name: "",
    token: "",
    refresh_token: "",
  });

  const queryClient = useQueryClient();
  const addMutation = QgridService.useAddTokenMutation();
  const oauthStartMutation = QgridService.useOauthStartMutation();

  const handleOAuthLogin = async () => {
    if (!form.name?.trim()) return;

    setOauthLoading(true);
    try {
      const { authUrl } = await oauthStartMutation.mutateAsync({ name: form.name.trim() });
      window.location.href = authUrl;
    } catch {
      setOauthLoading(false);
    }
  };

  const handleManualSubmit = async () => {
    if (!form.token?.trim() || !form.name?.trim()) return;

    const result = await addMutation.mutateAsync({
      token: form.token.trim(),
      name: form.name.trim(),
      refreshToken: form.refresh_token?.trim() ?? "",
    });
    if (!result.added) return;

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
    ]);
    close();
  };

  const close = () => {
    setOpen(false);
    reset();
    setShowToken(false);
    setOauthLoading(false);
  };

  return (
    <>
      <button
        type="button"
        className="px-3 py-1 text-xs font-medium rounded-md bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150 active:scale-[0.98] flex items-center gap-1"
        onClick={() => setOpen(true)}
      >
        <PlusIcon className="size-3.5" />
        Add Token
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div className="absolute inset-0" onClick={close} onKeyDown={() => {}} />

          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="px-5 py-4 border-b border-sand-100">
              <h2 className="text-base font-medium text-sand-900">Add Token</h2>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Name */}
              <div>
                <label
                  htmlFor="token-name"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  Name *
                </label>
                <Input
                  {...register("name")}
                  placeholder="e.g. your-token-name"
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                />
              </div>

              {/* OAuth Login */}
              <button
                type="button"
                className="w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white hover:bg-sand-800 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
                disabled={!form.name?.trim() || oauthLoading}
                onClick={handleOAuthLogin}
              >
                {oauthLoading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Waiting for login...
                  </span>
                ) : (
                  <>
                    <KeyIcon className="size-4" />
                    Login with Claude
                  </>
                )}
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-sand-200" />
                <span className="text-[10px] text-sand-400 uppercase">or</span>
                <div className="flex-1 h-px bg-sand-200" />
              </div>

              {/* Manual Token */}
              <div>
                <label
                  htmlFor="oauth-token"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  Access Token
                </label>
                <div className="relative mt-1">
                  <Input
                    type={showToken ? "text" : "password"}
                    {...register("token")}
                    placeholder="sk-ant-oat01-..."
                    className="w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300 pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sand-400 hover:text-sand-600 transition-colors duration-150"
                    onClick={() => setShowToken(!showToken)}
                  >
                    {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
              </div>

              {/* Refresh Token (optional) */}
              <div>
                <label
                  htmlFor="refresh-token"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  Refresh Token{" "}
                  <span className="text-sand-400 normal-case tracking-normal">(optional)</span>
                </label>
                <Input
                  type="password"
                  {...register("refresh_token")}
                  placeholder="sk-ant-ort01-..."
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                />
                <p className="text-[10px] text-sand-400 mt-1">
                  Enables auto-refresh when access token expires (~8h)
                </p>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-sand-100 flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md border border-sand-200 text-sand-600 hover:bg-sand-100 transition-colors duration-150"
                onClick={close}
              >
                Cancel
              </button>
              {form.token?.trim() && (
                <button
                  type="button"
                  className="px-3 py-1 text-xs font-medium rounded-md bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150"
                  disabled={!form.name?.trim() || !form.token?.trim() || addMutation.isPending}
                  onClick={handleManualSubmit}
                >
                  {addMutation.isPending ? "Adding..." : "Add Token"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
