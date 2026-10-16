# Дисклеймер

**Проект создан исключительно в образовательных и исследовательских целях
(Educational / Proof of Concept).**

Автор не связан с компанией Figma, Inc., не действует от её имени и не состоит
с ней в партнёрских, спонсорских, трудовых или иных официальных отношениях.
Автор не несёт ответственности за использование данного инструмента третьими
лицами или возможные нарушения условий использования внешних сервисов.

Этот текст — не юридическая консультация. Формулировки ниже описывают границы
ответственности автора, а не заменяют консультацию юриста.

---

## 1. Назначение

PixelBridge — локальный инструмент для личного обучения и исследований:
изучения того, как устроена вёрстка веб-страниц, как вычисленные CSS-стили
и геометрия переносятся в редактируемые слои, и как ИИ-агент может работать с
графическим редактором через локальный мост.

Проект **не является** коммерческим продуктом, сервисом, официальным
интеграционным решением Figma или заменой `html.to.design` и подобных сервисов.
Плагин не опубликован в Figma Community и устанавливается только в режиме
разработки (**Plugins → Development**), то есть в вашем личном экземпляре
Figma Desktop.

## 2. Отсутствие связи с Figma

Figma, Figma Desktop, Figma Community и логотипы Figma — товарные знаки
Figma, Inc. Здесь они упоминаются только для описания совместимости.
Автор не заявляет о поддержке, одобрении или проверке проекта со стороны
Figma, Inc.

Инструмент использует **официальный Plugin API Figma** и работает внутри
вашего собственного запущенного экземпляра Figma. Он не обходит системы
аутентификации и не получает доступ к аккаунту, файлам или данным, к которым
у вас нет прав.

## 3. Ответственность пользователя

Все решения о том, что и откуда импортировать, принимаете вы. В частности, вы
самостоятельно отвечаете за:

- **Соблюдение условий использования сайтов**, которые вы захватываете.
  Автоматизированный доступ к странице регулируется пользовательским
  соглашением конкретного сайта, а также `robots.txt` и техническими мерами
  защиты; проверять это — ваша задача.
- **Авторские права и товарные знаки.** Изображения, шрифты, тексты, вёрстка
  и логотипы, попавшие в захваченную страницу, принадлежат их правообладателям.
  Перенос страницы в Figma не даёт вам прав на её содержимое и не является
  основанием для его использования, публикации или распространения.
  Используйте захват для референса, обучения и анализа, а не для присвоения
  чужого контента.
- **Персональные данные и конфиденциальную информацию.** Захваченная страница
  и её ассеты сохраняются на диск. Не импортируйте страницы, содержащие чужие
  персональные данные, если у вас нет на это законных оснований, и помните,
  что всё попавшее в кэш может остаться на диске.
- **Режим «ваш профиль Chrome» и «постоянный» профиль.** Они используют ваши
  реальные сессии и куки. Включайте их только на своих аккаунтах и помните,
  что содержимое профиля (`engine/.profile/`) — это ваши живые учётные данные.
- **Последствия использования инструмента.** Автор не отвечает за потерю
  данных, содержимое ваших файлов Figma, срабатывание лимитов, блокировки
  аккаунтов или иной ущерб, возникший в результате применения проекта.

Автор не проверяет, не модерирует и не контролирует, какие страницы вы
импортируете и что вы делаете с полученными слоями.

## 4. Обработка данных

Проект работает локально: страницы рендерит ваш собственный браузер, слои
плагин пишет напрямую в открытый файл через Plugin API. Движок слушает только
`127.0.0.1`. Никакой телеметрии, аналитики, автообновлений и передачи данных
третьим лицам в проекте нет; зависимостей, которые могли бы это делать, тоже
нет (`"dependencies": {}`).

Единственные исходящие запросы — за страницей, которую вы сами указали, и за
изображениями с этой страницы. Подробнее — в разделе «Приватность» файла
[README.md](README.md).

## 5. Отсутствие гарантий

Программа предоставляется «как есть» (AS IS), без каких-либо гарантий, явных
или подразумеваемых, включая гарантии товарной пригодности, пригодности для
конкретной цели и отсутствия нарушений прав. Полные условия — в файле
[LICENSE](LICENSE) (MIT).

Автор не обязан сопровождать проект, исправлять ошибки, отвечать на обращения
или поддерживать совместимость с будущими версиями Figma и браузеров.
Поведение инструмента зависит от версии Figma и её возможностей, которые могут
меняться без предупреждения.

## 6. Если вы правообладатель

Если вы считаете, что материалы этого репозитория нарушают ваши права,
свяжитесь с автором через Issues в репозитории
<https://github.com/AGNARE/PixelBridge> — вопрос будет рассмотрен и, при
необходимости, соответствующий материал удалён.

---

# Disclaimer (English)

**This project was created solely for educational and research purposes
(Educational / Proof of Concept).**

The author is not affiliated with Figma, Inc., does not act on its behalf, and
has no partnership, sponsorship or other official relationship with it. The
author bears no responsibility for third-party use of this tool or for any
violation of the terms of service of external services.

**No warranty.** The software is provided "as is", without warranty of any kind,
express or implied. See [LICENSE](LICENSE) (MIT).

**Your responsibility.** You are solely responsible for complying with the terms
of service of any website you capture, for respecting copyright and trademarks
in the captured content, and for handling any personal data lawfully. Capturing
a page does not grant you any rights to its content. You are also responsible
for the consequences of using this tool, including any data loss or changes to
your Figma files. The author does not review, moderate or control which pages
you import or what you do with the resulting layers.

**No affiliation.** Figma and the Figma logo are trademarks of Figma, Inc.
They are referenced here only to describe compatibility. This is not an official
Figma integration and is not endorsed or reviewed by Figma, Inc. The plugin is
not published to the Figma Community; it installs as a local development plugin
inside your own Figma Desktop instance.

**Local processing.** The project runs entirely on your machine and includes no
telemetry, analytics or auto-updates. The only outbound requests are for the page
you explicitly asked to capture and for images found on that page. See the
Privacy section of [README.md](README.md).

This text is not legal advice; it describes the limits of the author's
responsibility and does not replace consulting a lawyer.
