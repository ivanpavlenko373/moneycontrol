// Налаштування додатку. Обов'язково вкажіть CLIENT_ID (див. README.md).
window.CONFIG = {
  // OAuth Client ID типу "Web application" з Google Cloud Console
  // приклад: '1234567890-abcdefg.apps.googleusercontent.com'
  CLIENT_ID: '',

  // true — працювати без Google, дані лише в браузері (для перевірки інтерфейсу).
  // Також можна відкрити додаток з параметром ?demo=1
  DEMO: false,

  DEFAULT_CURRENCY: 'UAH',
  CURRENCIES: ['UAH', 'USD', 'EUR', 'PLN', 'GBP'],

  // Назва нової таблиці за замовчуванням
  SHEET_NAME: 'MoneyControl',

  // Назва першого гаманця, який створюється разом із таблицею
  FIRST_WALLET: 'Основний',
};
