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
    m.photosStarted = false

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
    if m.top.screensaver then startPhotos()
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
    m.top.findNode("photoClock").text = m.clock.text
    m.top.findNode("photoDate").text = m.date.text

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
    renderPhotoStrip(d)

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
    return addLabelTo(m.events, text, x, y, size, bold, color, width)
end function

function addLabelTo(parent as object, text as string, x as integer, y as integer, size as integer, bold as boolean, color as string, width as integer) as object
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
    parent.appendChild(label)
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

' ─── Screensaver slideshow ──────────────────────────────────────────────────
' An "anchor" screen, then PHOTOS_BETWEEN photos from the hub's iCloud shared
' album (shuffled), then the next anchor; SLIDE_SECONDS each, with crossfades.
' Anchors cycle through the hub screen and each upcoming trip:
'   hub, 3 photos, trip 1, 3 photos, trip 2, 3 photos, trip 3, 3 photos, hub, …
' Photos carry a strip with the clock, next event, and trip countdown. With no
' album (or no photos) the hub screen stays up.

sub startPhotos()
    if m.config.url = "" or m.photosStarted then return
    m.photosStarted = true
    m.SLIDE_SECONDS = 10
    m.PHOTOS_BETWEEN = 3
    m.photosSinceAnchor = 0
    m.anchorIndex = 0        ' 0 = hub, n = trips[n - 1]
    m.photos = []
    m.photoIndex = 0
    m.trips = []
    m.heroPaths = {}
    m.ready = invalid        ' downloaded photo waiting to be shown { path }
    m.showing = "hub"        ' "hub" | "photo" | "trip"
    m.fileCounter = 0
    m.frontPoster = m.top.findNode("photoA")
    m.backPoster = m.top.findNode("photoB")
    m.photoLayer = m.top.findNode("photoLayer")
    m.tripLayer = m.top.findNode("tripLayer")
    m.slideTimer = makeTimer(m.SLIDE_SECONDS, "onSlide")
    m.photoListTimer = makeTimer(600, "loadPhotoList")
    m.tripsTimer = makeTimer(600, "loadTrips")
    loadPhotoList()
    loadTrips()
end sub

function photoConfig(extra as object) as object
    cfg = { url: m.config.url, clientId: m.config.clientId, clientSecret: m.config.clientSecret }
    cfg.Append(extra)
    return cfg
end function

sub runTask(cfg as object, handler as string, slot as string)
    task = CreateObject("roSGNode", "FetchTask")
    task.config = photoConfig(cfg)
    task.observeField("result", handler)
    task.control = "RUN"
    m[slot] = task
end sub

sub loadPhotoList()
    runTask({ mode: "photos" }, "onPhotoList", "photoListTask")
end sub

sub onPhotoList(event as object)
    result = event.getData()
    if result.photos = invalid or result.photos.count() = 0 then return
    ' Shuffle (Fisher-Yates).
    photos = result.photos
    for i = photos.count() - 1 to 1 step -1
        j = Rnd(i + 1) - 1
        t = photos[i]
        photos[i] = photos[j]
        photos[j] = t
    end for
    first = m.photos.count() = 0
    m.photos = photos
    m.photoIndex = 0
    if first then downloadNext()
end sub

sub downloadNext()
    if m.photos.count() = 0 then return
    photo = m.photos[m.photoIndex mod m.photos.count()]
    m.photoIndex = m.photoIndex + 1
    m.fileCounter = m.fileCounter + 1
    runTask({ mode: "download", id: photo.id, path: "tmp:/photo-" + m.fileCounter.ToStr() + ".jpg" }, "onPhotoDownloaded", "downloadTask")
end sub

sub onPhotoDownloaded(event as object)
    result = event.getData()
    if result.path <> invalid then m.ready = result
end sub

sub loadTrips()
    runTask({ mode: "trips" }, "onTrips", "tripsTask")
end sub

sub onTrips(event as object)
    result = event.getData()
    if result.trips = invalid then return
    m.trips = result.trips
    ' Hero photos: fetched once per screensaver session.
    for each t in m.trips
        if t.hero <> invalid and m.heroPaths[t.id] = invalid then
            m.heroPaths[t.id] = ""
            runTask({ mode: "download", fullUrl: t.hero, id: t.id, path: "tmp:/hero-" + t.id + ".jpg" }, "onHeroDownloaded", "heroTask_" + t.id)
        end if
    end for
end sub

sub onHeroDownloaded(event as object)
    result = event.getData()
    if result.path <> invalid then m.heroPaths[result.id] = result.path
end sub

sub onSlide()
    if m.showing = "photo" and m.photosSinceAnchor >= m.PHOTOS_BETWEEN then
        showNextAnchor()
        return
    end if
    if m.ready = invalid then return   ' next photo not downloaded yet: keep what's showing
    ' Load into the back poster; onPosterLoaded fades it in once decoded.
    old = m.backPoster.uri
    m.backPoster.unobserveField("loadStatus")
    m.backPoster.observeField("loadStatus", "onPosterLoaded")
    m.backPoster.uri = m.ready.path
    m.ready = invalid
    if old <> "" then DeleteFile(old)
end sub

sub onPosterLoaded()
    status = m.backPoster.loadStatus
    if status <> "ready" and status <> "failed" then return
    m.backPoster.unobserveField("loadStatus")
    downloadNext()
    if status = "failed" then return

    if m.showing = "photo" then
        ' Photo → photo: crossfade the posters.
        m.top.findNode("fadeIn").fieldToInterp = m.backPoster.id + ".opacity"
        m.top.findNode("fadeOut").fieldToInterp = m.frontPoster.id + ".opacity"
        m.top.findNode("photoFade").control = "start"
        m.photosSinceAnchor = m.photosSinceAnchor + 1
    else
        ' Hub or trip → photo.
        m.backPoster.opacity = 1
        m.frontPoster.opacity = 0
        swapTo("photo")
        m.photosSinceAnchor = 1
    end if
    t = m.frontPoster
    m.frontPoster = m.backPoster
    m.backPoster = t
end sub

sub showNextAnchor()
    m.photosSinceAnchor = 0
    m.anchorIndex = (m.anchorIndex + 1) mod (m.trips.count() + 1)
    if m.anchorIndex = 0 then
        swapTo("hub")
    else
        renderTripScreen(m.trips[m.anchorIndex - 1])
        swapTo("trip")
    end if
end sub

' Crossfades from the layer showing now to `target` ("hub" | "photo" | "trip").
sub swapTo(target as string)
    layers = { hub: m.layout, photo: m.photoLayer, trip: m.tripLayer }
    fromNode = layers[m.showing]
    toNode = layers[target]
    m.showing = target
    if fromNode.isSameNode(toNode) then return
    toNode.opacity = 0
    toNode.visible = true
    m.top.findNode("swapIn").fieldToInterp = toNode.id + ".opacity"
    m.top.findNode("swapOut").fieldToInterp = fromNode.id + ".opacity"
    m.top.findNode("swap").control = "start"
end sub

sub renderTripScreen(t as object)
    hero = m.heroPaths[t.id]
    if hero = invalid then hero = ""
    m.top.findNode("tripHero").uri = hero
    title = t.title
    if t.titleAccent <> invalid then title = title + " " + t.titleAccent
    m.top.findNode("tripTitle").text = title
    m.top.findNode("tripResort").text = valueOr(t.resort, "")
    m.top.findNode("tripRange").text = t.dates

    big = m.top.findNode("tripBig")
    label = m.top.findNode("tripBigLabel")
    if t.status = "active" then
        big.text = "Day " + t.day.ToStr()
        label.text = "of " + t.days.ToStr()
    else
        big.text = t.daysUntil.ToStr()
        unit = "days"
        if t.daysUntil = 1 then unit = "day"
        label.text = unit + " " + valueOr(t.countdown, "to go")
    end if

    ' Today's plan, while the trip is on.
    today = m.top.findNode("tripToday")
    today.removeChildrenIndex(today.getChildCount(), 0)
    if t.today <> invalid then
        y = 0
        for each item in t.today
            if y > 240 then exit for
            line = valueOr(item.title, "")
            if item.time <> invalid then line = item.time + "   " + line
            addLabelTo(today, line, 0, y, 34, false, m.TEXT, 960)
            y = y + 50
        end for
    end if

    ' Leaderboard.
    heading = UCase(valueOr(t.team, "Leaderboard"))
    heading = heading + "  ·  " + t.questsDone.ToStr() + " OF " + t.questsTotal.ToStr() + " QUESTS"
    m.top.findNode("tripBoardTitle").text = heading
    board = m.top.findNode("tripBoard")
    board.removeChildrenIndex(board.getChildCount(), 0)
    rows = t.leaderboard
    shown = 0
    for each r in rows
        if shown >= 10 then exit for
        y = shown * 76
        addLabelTo(board, (shown + 1).ToStr(), 0, y + 6, 36, false, m.MUTED, 50)
        bar = CreateObject("roSGNode", "Rectangle")
        bar.width = 8
        bar.height = 52
        bar.translation = [60, y + 2]
        bar.color = toColor(r.color)
        board.appendChild(bar)
        addLabelTo(board, r.name, 92, y, 44, false, m.TEXT, 440)
        pts = addLabelTo(board, r.points.ToStr(), 540, y, 44, true, m.TEXT, 160)
        pts.horizAlign = "right"
        shown = shown + 1
    end for
    if rows.count() > shown then
        addLabelTo(board, "+" + (rows.count() - shown).ToStr() + " more", 92, shown * 76 + 6, 32, false, m.MUTED, 600)
    end if
end sub

function valueOr(v as dynamic, fallback as string) as string
    if v = invalid then return fallback
    return v
end function

sub renderPhotoStrip(d as object)
    nextText = ""
    for each e in d.events
        if not e.allDay then
            prefix = ""
            if e.day <> "Today" then prefix = e.day + " "
            nextText = "Next: " + prefix + e.time + "   " + e.title
            exit for
        end if
    end for
    m.top.findNode("photoNext").text = nextText
    tripText = ""
    t = d.nextTrip
    if t <> invalid then
        if t.status = "active" then
            tripText = t.name + " · day " + t.day.ToStr() + " of " + t.days.ToStr()
        else if t.daysUntil = 1 then
            tripText = t.name + " tomorrow"
        else
            tripText = t.name + " in " + t.daysUntil.ToStr() + " days"
        end if
    end if
    m.top.findNode("photoTrip").text = tripText
end sub
