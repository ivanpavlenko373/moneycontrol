// Налаштування додатку. Обов'язково вкажіть CLIENT_ID (див. README.md).
window.CONFIG = {
  // OAuth Client ID типу "Web application" з Google Cloud Console
  // приклад: '1234567890-abcdefg.apps.googleusercontent.com'
  CLIENT_ID: '1051817506899-bhqln3hn0orh0esolc67nas5apbt82f9.apps.googleusercontent.com',

  // true — працювати без Google, дані лише в браузері (для перевірки інтерфейсу).
  // Також можна відкрити додаток з параметром ?demo=1
  DEMO: false,

  // Адреса повернення після входу Google. Порожньо — поточна адреса сторінки
  // (https://ivanpavlenko373.github.io/moneycontrol/). Вона ж має бути в
  // Authorized redirect URIs OAuth-клієнта в Google Cloud Console.
  REDIRECT_URI: '',

  DEFAULT_CURRENCY: 'UAH',
  CURRENCIES: ['UAH', 'USD', 'EUR', 'PLN', 'GBP'],

  // Назва нової таблиці за замовчуванням
  SHEET_NAME: 'MoneyControl',

  // Назва першого гаманця, який створюється разом із таблицею
  FIRST_WALLET: 'Основний',
};
