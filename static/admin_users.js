const $ = (selector) => document.querySelector(selector);
const form = $("#adminAccountForm");
let managedRow = null;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

function clearError() {
  const error = $("#accountFormError");
  error.hidden = true;
  error.textContent = "";
}

function setCreateMode() {
  managedRow = null;
  form.reset();
  form.elements.user_id.value = "";
  form.elements.password.required = true;
  $(".active-account-field").hidden = true;
  $("#accountFormTitle").textContent = "Create Account";
  $("#accountFormContext").innerHTML =
    "Registration mode: <strong>admin_only</strong>";
  $("#accountPasswordLabel").textContent = "Temporary Password";
  $("#saveAccountButton").textContent = "Create Account";
  $("#cancelManageAccount").hidden = true;
  clearError();
}

function setManageMode(row) {
  managedRow = row;
  form.reset();
  form.elements.user_id.value = row.dataset.userId;
  form.elements.display_name.value = row.dataset.displayName;
  form.elements.email.value = row.dataset.email;
  form.elements.role.value = row.dataset.role;
  form.elements.active.checked = row.dataset.active === "true";
  form.elements.password.value = "";
  form.elements.password.required = false;
  $(".active-account-field").hidden = false;
  $("#accountFormTitle").textContent = "Manage Account";
  $("#accountFormContext").textContent =
    `${row.dataset.displayName} · ${row.dataset.email}`;
  $("#accountPasswordLabel").textContent =
    "Temporary Password (leave blank to keep current)";
  $("#saveAccountButton").textContent = "Save Account";
  $("#cancelManageAccount").hidden = false;
  clearError();
  form.elements.display_name.focus();
}

document.querySelectorAll(".manage-user-trigger").forEach((button) => {
  button.addEventListener("click", () =>
    setManageMode(button.closest(".user-row"))
  );
});

$("#cancelManageAccount").addEventListener("click", setCreateMode);

form.addEventListener("submit", async (event) => {
  if (!managedRow) return;
  event.preventDefault();
  clearError();
  const submit = $("#saveAccountButton");
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    const response = await fetch(
      `/api/administration/users/${form.elements.user_id.value}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: form.elements.display_name.value.trim(),
          email: form.elements.email.value.trim(),
          password: form.elements.password.value,
          role: form.elements.role.value,
          active: form.elements.active.checked,
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Account could not be saved.");
    }
    managedRow.dataset.displayName = data.user.display_name;
    managedRow.dataset.email = data.user.email;
    managedRow.dataset.role = data.user.role;
    managedRow.dataset.active = String(data.user.active);
    managedRow.querySelector(".user-display-name").textContent =
      data.user.display_name;
    managedRow.querySelector(".user-email").textContent = data.user.email;
    const role = managedRow.querySelector(".role-pill");
    role.textContent =
      data.user.role[0].toUpperCase() + data.user.role.slice(1);
    role.className = `role-pill ${data.user.role}`;
    showToast(`Account updated for ${data.user.display_name}.`);
    setCreateMode();
  } catch (exception) {
    const error = $("#accountFormError");
    error.textContent = exception.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
    if (managedRow) submit.textContent = "Save Account";
  }
});
