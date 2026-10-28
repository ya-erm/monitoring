// Public configuration only. Never put S3 write credentials in this directory.
window.MONITORING_CONFIG = Object.freeze({
  enabled: false,
  title: "Сервер",
  // HTTPS URL of the public S3 prefix, without a trailing slash.
  dataBaseUrl: "",
  refreshSeconds: 60,
  staleAfterSeconds: 150,
});
