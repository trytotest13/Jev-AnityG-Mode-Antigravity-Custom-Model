/**
 * IDE Install Wizard - HTML template for the wizard UI.
 *
 * This is a self-contained page with all CSS/JS embedded, rendered inline
 * in a standalone BrowserWindow.
 */

/**
 * Returns the inline HTML for the IDE install wizard.
 * This is a self-contained page with all CSS/JS embedded.
 */
export function getWizardHtml(iconBase64: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to Antigravity</title>
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: system-ui, sans-serif;
    background: #000;
    color: #F5F5F5;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    -webkit-app-region: drag;
    -webkit-user-select: none;
    user-select: none;
  }

  /* Traffic-light spacer for macOS */
  .titlebar-spacer {
    height: 38px;
    flex-shrink: 0;
  }

  .container {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 68px 68px;
    -webkit-app-region: no-drag;
  }

  /* --- Step screens --- */
  .step {
    display: none;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 480px;
    width: 100%;
  }
  .step.active {
    display: flex;
  }

  /* Icon */
  .icon-wrapper {
    width: 80px;
    height: 80px;
    margin-bottom: 32px;
  }
  .icon-wrapper img {
    width: 100%;
    height: 100%;
    border-radius: 18px;
  }

  h1 {
    font-size: 19px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 8px;
    letter-spacing: -0.02em;
  }

  p {
    font-size: 14px;
    line-height: 1.6;
    color: #A0A0A0;
    margin-bottom: 36px;
  }

  /* Loader styling */
  .loader {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    color: #2F80ED;
  }

  /* Checkbox styling */
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 14px;
    color: #A0A0A0;
    margin-bottom: 18px;
    -webkit-app-region: no-drag;
  }

  /* Buttons */
  .button-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    max-width: 320px;
  }

  button {
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    padding: 13px 24px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .btn-primary {
    background: #2F80ED;
    color: #fff;
  }
  .btn-primary:hover {
    background: #2D74D7;
  }

</style>
</head>
<body>
  <div class="titlebar-spacer"></div>
  <div class="container">

    <!-- Step 0: Setting up -->
    <div id="step-setup" class="step active">
      <div class="loader">Setting up…</div>
    </div>

    <!-- Step 1: Welcome -->
    <div id="step-ask" class="step">
      <div class="icon-wrapper">
        <img src="data:image/png;base64,${iconBase64}" alt="Antigravity Icon">
      </div>
      <h1>Welcome to the new Antigravity!</h1>
      <p>Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.</p>

      <label class="checkbox-label">
        <input type="checkbox" id="chk-download" checked>
        <span>Download the Antigravity IDE</span>
      </label>

      <div class="button-group">
        <button class="btn-primary" id="btn-skip">Explore the new Antigravity</button>
      </div>
    </div>

  </div>

<script>
  function showStep(stepId) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById(stepId).classList.add('active');
  }

  document.getElementById('btn-skip').addEventListener('click', async () => {
    const chk = document.getElementById('chk-download');
    const shouldDownload = chk ? chk.checked : false;
    await window.wizardAPI.completeWizard(shouldDownload);
  });

  window.wizardAPI.onSetupComplete(() => {
    showStep('step-ask');
  });
</script>
</body>
</html>`;
}
