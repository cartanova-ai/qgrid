import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import experiment


class ExperimentTests(unittest.TestCase):
    def test_config_is_private_and_disables_paid_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            with patch.object(experiment, "DATA", data):
                experiment.prepare()
                key = (data / "api-key").read_text()
                experiment.prepare()
                self.assertEqual((data / "api-key").read_text(), key)
                config = (data / "config.yaml").read_text()
                self.assertIn('host: "127.0.0.1"', config)
                self.assertIn("antigravity-credits: false", config)
                self.assertIn("switch-preview-model: false", config)
                self.assertEqual((data / "config.yaml").stat().st_mode & 0o777, 0o600)
                self.assertEqual(data.stat().st_mode & 0o777, 0o700)

    def test_child_uses_only_experiment_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            (data / "cli-proxy-api").touch()
            with (
                patch.object(experiment, "DATA", data),
                patch.dict(os.environ, {"GEMINI_API_KEY": "not-for-child", "HOME": "/original"}),
                patch("experiment.subprocess.call", return_value=0) as run,
            ):
                self.assertEqual(experiment.run_proxy(True), 0)
                args = run.call_args.args[0]
                self.assertIn("-antigravity-login", args)
                env = run.call_args.kwargs["env"]
                self.assertNotIn("GEMINI_API_KEY", env)
                self.assertEqual(env["HOME"], str(data / "home"))

    def test_smoke_requires_advertised_model_before_generation(self):
        with patch("experiment.models", return_value=[]), patch("experiment.request") as request:
            with self.assertRaisesRegex(RuntimeError, "not advertised"):
                experiment.smoke("unknown", False)
            request.assert_not_called()

    def test_nonstream_checks_model_output(self):
        response = {"choices": [{"message": {"content": "QGRID_AG_OK"}}]}
        with (
            patch("experiment.models", return_value=["test-model"]),
            patch("experiment.request", return_value=io.BytesIO(json.dumps(response).encode())),
            patch("builtins.print") as output,
        ):
            experiment.smoke("test-model", False)
            self.assertTrue(json.loads(output.call_args.args[0])["passed"])

    def test_stream_requires_done_and_handles_split_deltas(self):
        deltas = ["QGRID_", "AG_OK"]
        chunks = [json.dumps({"choices": [{"delta": {"content": value}}]}) for value in deltas]
        content = "\n\n".join(f"data: {value}" for value in chunks) + "\n\ndata: [DONE]\n\n"
        with (
            patch("experiment.models", return_value=["test-model"]),
            patch("experiment.request", return_value=io.BytesIO(content.encode())),
            patch("builtins.print"),
        ):
            experiment.smoke("test-model", True)
        with (
            patch("experiment.models", return_value=["test-model"]),
            patch("experiment.request", return_value=io.BytesIO(content.replace("data: [DONE]", "").encode())),
        ):
            with self.assertRaisesRegex(RuntimeError, "completion marker"):
                experiment.smoke("test-model", True)


if __name__ == "__main__":
    unittest.main()
