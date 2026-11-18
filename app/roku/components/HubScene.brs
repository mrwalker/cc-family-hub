' The hub screen. Fetches /api/widget every 5 minutes (via FetchTask) and
' lays it out; left/right on the remote switch whose events are shown.

sub init()
    m.TEXT = "0xf3f5f7FF"
    m.MUTED = "0xf3f5f78C"
    m.ACCENT = "0x7dd3fcFF"
    m.MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    m.layout = m.top.findNode("layout")
    m.viewLabel = m.top.findNode("viewLabel")
    m.clock = m.top.findNode("clock")
    m.date = m.top.findNode("date")
    m.events = m.top.findNode("events")
    m.message = m.top.findNode("message")
    m.status = m.top.findNode("status")
    m.hint = m.top.findNode("hint")
    m.trip = m.top.findNode("trip")

    m.config = loadConfig()
    m.registry = CreateObject("roRegistrySection", "family-hub")
    m.view = m.registry.Read("view")
    if m.view = "" then m.view = m.config.view
    if m.view = "" then m.view = "family"
    m.data = invalid
    m.error = ""
    m.ticks = 0

    m.clockTimer = makeTimer(5, "onClock")
    m.refreshTimer = makeTimer(300, "refresh")
    onClock()
    showViewName()

    if m.config.url = "" then
        m.message.text = "No hub is set up. Rebuild the channel with HUB_URL in roku.env (see app/roku/README.md)."
    else
        m.message.text = "Loading…"
        refresh()
    end if
    m.top.setFocus(true)
end sub

function loadConfig() as object
    cfg = invalid
    text = ReadAsciiFile("pkg:/config.json")
    if text <> "" then cfg = ParseJson(text)
    if cfg = invalid then cfg = {}
    for each key in ["url", "clientId", "clientSecret", "view"]
        if cfg[key] = invalid then cfg[key] = ""
    end for
    return cfg
end function

function makeTimer(seconds as integer, handler as string) as object
    t = CreateObject("roSGNode", "Timer")
    t.duration = seconds
    t.repeat = true
    t.observeField("fire", handler)
    t.control = "start"
    return t
end function

sub onModeChange()
    m.hint.visible = not m.top.screensaver
end sub

' ─── Data ────────────────────────────────────────────────────────────────────

sub refresh()
    if m.config.url = "" then return
    task = CreateObject("roSGNode", "FetchTask")
    task.config = { url: m.config.url, view: m.view, clientId: m.config.clientId, clientSecret: m.config.clientSecret }
    task.observeField("result", "onResult")
    task.control = "RUN"
    m.task = task
end sub

sub onResult(event as object)
    result = event.getData()
    if result.data <> invalid then
        m.data = result.data
        m.error = ""
    else
        m.error = result.error
    end if
    render()
end sub

' ─── Remote ──────────────────────────────────────────────────────────────────

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "left" or key = "right" then
        ids = ["family"]
        if m.data <> invalid then
            for each member in m.data.members
                ids.push(member.id)
            end for
        end if
        index = 0
        for i = 0 to ids.count() - 1
            if ids[i] = m.view then index = i
        end for
        if key = "right" then index = index + 1 else index = index - 1
        if index < 0 then index = ids.count() - 1
        if index >= ids.count() then index = 0
        m.view = ids[index]
        m.registry.Write("view", m.view)
        m.registry.Flush()
        showViewName()
        refresh()
        return true
    else if key = "OK" or key = "replay" then
        refresh()
        return true
    end if
    return false
end function

sub showViewName()
    m.viewLabel.text = "FAMILY"
    m.viewLabel.color = m.ACCENT
    if m.view = "family" or m.data = invalid then
        if m.view <> "family" then m.viewLabel.text = UCase(m.view)
        return
    end if
    for each member in m.data.members
        if member.id = m.view then
            m.viewLabel.text = UCase(member.name)
            m.viewLabel.color = toColor(member.color)
        end if
    end for
end sub

' ─── Clock ───────────────────────────────────────────────────────────────────

sub onClock()
    now = CreateObject("roDateTime")
    now.ToLocalTime()
    m.clock.text = timeText(now)
    m.date.text = now.GetWeekday() + ", " + m.MONTHS[now.GetMonth() - 1] + " " + now.GetDayOfMonth().ToStr()

    ' As a screensaver, drift a little each minute so nothing burns in.
    m.ticks = m.ticks + 1
    if m.top.screensaver and m.ticks mod 12 = 0 then
        offsets = [[0, 0], [-40, -30], [40, 20], [-30, 30], [30, -30], [0, 30]]
        m.layout.translation = offsets[(m.ticks \ 12) mod offsets.count()]
    end if
end sub

function timeText(dt as object) as string
    h = dt.GetHours()
    minutes = dt.GetMinutes()
    suffix = " AM"
    if h >= 12 then suffix = " PM"
    h = h mod 12
    if h = 0 then h = 12
    mm = minutes.ToStr()
    if minutes < 10 then mm = "0" + mm
    return h.ToStr() + ":" + mm + suffix
end function

' ─── Layout ──────────────────────────────────────────────────────────────────

sub render()
    m.events.removeChildrenIndex(m.events.getChildCount(), 0)
    status = ""
    if m.data = invalid then
        m.message.text = m.error
        m.trip.visible = false
        m.status.text = ""
        return
    end if

    d = m.data
    showViewName()
    m.message.text = ""
    if d.events.count() = 0 then
        if d.eventsError <> invalid then
            m.message.text = "Calendars didn't load: " + d.eventsError
        else
            m.message.text = "Nothing else today or tomorrow"
        end if
    end if

    y = 0
    day = ""
    shown = 0
    for each e in d.events
        rowHeight = 84
        if e.location <> invalid then rowHeight = 122
        headHeight = 0
        if e.day <> day then
            headHeight = 64
            if day <> "" then headHeight = headHeight + 28
        end if
        if y + headHeight + rowHeight > 860 then exit for
        if e.day <> day then
            if day <> "" then y = y + 28
            addLabel(UCase(e.day), 0, y, 28, true, m.MUTED, 600)
            y = y + 64
            day = e.day
        end if
        addEvent(e, y)
        y = y + rowHeight
        shown = shown + 1
    end for
    more = d.events.count() - shown
    if d.moreEvents <> invalid then more = more + d.moreEvents
    if more > 0 then addLabel("+" + more.ToStr() + " more", 36, y, 32, false, m.MUTED, 600)

    renderTrip(d.nextTrip)

    status = "Updated " + isoTimeText(d.generatedAt)
    if m.error <> "" then status = "Offline since " + isoTimeText(d.generatedAt) + " · " + m.error
    m.status.text = status
end sub

sub addEvent(e as object, y as integer)
    colors = e.colors
    if colors = invalid or colors.count() = 0 then colors = ["#888888"]
    n = colors.count()
    if n > 4 then n = 4
    barHeight = 60
    if e.location <> invalid then barHeight = 98
    segment = Int(barHeight / n)
    for i = 0 to n - 1
        bar = CreateObject("roSGNode", "Rectangle")
        bar.width = 8
        bar.height = segment
        bar.translation = [0, y + 2 + i * segment]
        bar.color = toColor(colors[i])
        m.events.appendChild(bar)
    end for
    addLabel(e.time, 32, y + 8, 34, false, m.MUTED, 200)
    addLabel(e.title, 236, y, 46, true, m.TEXT, 744)
    if e.location <> invalid then addLabel(e.location, 236, y + 58, 30, false, m.MUTED, 744)
end sub

sub renderTrip(t as dynamic)
    if t = invalid then
        m.trip.visible = false
        return
    end if
    m.trip.visible = true
    caption = m.top.findNode("tripCaption")
    number = m.top.findNode("tripNumber")
    if t.status = "active" then
        caption.text = "ON THE TRIP · DAY OF " + t.days.ToStr()
        number.text = t.day.ToStr()
    else
        caption.text = "DAYS TO GO"
        if t.daysUntil = 1 then caption.text = "DAY TO GO"
        number.text = t.daysUntil.ToStr()
    end if
    m.top.findNode("tripName").text = t.name
    m.top.findNode("tripDates").text = dayText(t.startDate) + " – " + dayText(t.endDate)
end sub

function addLabel(text as string, x as integer, y as integer, size as integer, bold as boolean, color as string, width as integer) as object
    font = CreateObject("roSGNode", "Font")
    font.uri = "font:SystemFontFile"
    if bold then font.uri = "font:BoldSystemFontFile"
    font.size = size
    label = CreateObject("roSGNode", "Label")
    label.font = font
    label.text = text
    label.color = color
    label.width = width
    label.translation = [x, y]
    m.events.appendChild(label)
    return label
end function

' ─── Formatting ──────────────────────────────────────────────────────────────

function toColor(hex as string) as string
    return "0x" + Mid(hex, 2, 6) + "FF"
end function

' "2026-11-24" → "Nov 24"
function dayText(ymd as string) as string
    month = Int(Val(Mid(ymd, 6, 2)))
    if month < 1 or month > 12 then return ymd
    return m.MONTHS[month - 1] + " " + Int(Val(Mid(ymd, 9, 2))).ToStr()
end function

' "2026-11-18T21:56:12.123Z" → "3:56 PM" local
function isoTimeText(iso as string) as string
    base = iso
    dot = Instr(1, iso, ".")
    if dot > 0 then base = Left(iso, dot - 1) + "Z"
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(base)
    dt.ToLocalTime()
    return timeText(dt)
end function
