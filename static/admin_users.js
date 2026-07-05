const $ = (selector) => document.querySelector(selector);
const modal = $("#resetPasswordModal");
const form = $("#resetPasswordForm");

function openResetPassword(button) {
  form.reset();
  form.elements.user_id.value = button.dataset.userId;
  $("#resetPasswordName").textContent = button.dataset.displayName;
  $("#resetPasswordEmail").textContent = button.dataset.email;
  $("#resetPasswordError").hidden = true;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  form.elements.new_password.focus();
}

function closeResetPassword() {
  modal.hidden = true;
  form.reset();
  $("#resetPasswordError").hidden = true;
  document.body.style.overflow = "";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

document.querySelectorAll(".reset-password-trigger").forEach((button) => {
  button.addEventListener("click", () => openResetPassword(button));
});

$("#closeResetPassword").addEventListener("click", closeResetPassword);
$("#cancelResetPassword").addEventListener("click", closeResetPassword);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeResetPassword();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#resetPasswordError");
  const submit = form.querySelector('button[type="submit"]');
  error.hidden = true;
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    const response = await fetch(
      `/api/administration/users/${form.elements.user_id.value}/reset-password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_password: form.elements.new_password.value,
          confirm_password: form.elements.confirm_password.value,
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Password could not be reset.");
    closeResetPassword();
    showToast(`Password updated for ${data.user.display_name}.`);
  } catch (exception) {
    error.textContent = exception.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Save Password";
  }
});
