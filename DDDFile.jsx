import { useState, useEffect } from "react";
import {
  Card,
  Grid,
  Select,
  MenuItem,
  Button,
  Typography,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  CircularProgress,
} from "@mui/material";
import { ArrowBack, Refresh } from "@mui/icons-material";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import ReactApexChart from "react-apexcharts";
import { useLocation } from "react-router-dom";
import CustomDateRangePicker from "src/components/CustomDateRangePicker/CustomDateRangePicker";

import { useQueryGetDriverLookup } from "src/queries/driver.queries";
import { useQueryGetTachoDriverActivity } from "src/queries/tacho.queries";

dayjs.extend(isBetween);

// Driver states with color mapping
const DRIVER_STATES = {
  DRIVING: { name: "Driving (within limit)", color: "#52c41a" },
  DRIVING_WARNING: { name: "Driving (approaching 4h30)", color: "#faad14" },
  DRIVING_VIOLATION: { name: "Driving (over 4h30)", color: "#f5222d" },
  BREAK: { name: "Break", color: "#1890ff" },
  REST: { name: "Rest", color: "#722ed1" },
  AVAILABLE: { name: "Available", color: "#13c2c2" },
  WORK: { name: "Work (not driving)", color: "gray" },
  NOT_AVAILABLE: { name: "Not Available", color: "#ffccc7" },
  EMPTY: { name: "No Data", color: "#ffc7c7" },
};

const calculateDrivingTime = (states) => {
  const drivingMinutes = states
    .filter((s) => s.state.includes("DRIVING"))
    .reduce((sum, s) => sum + s.duration, 0);

  const hours = Math.floor(drivingMinutes / 60);
  const minutes = drivingMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
};

const getMinutesFromDuration = (durationStr) => {
  const match = durationStr.match(/(\d+)h(?:(\d+))?/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2] || "0", 10);
  return hours * 60 + minutes;
};

const getTotalDurationByState = (key, activityData) => {
  const allActivities = activityData?.days?.flatMap(
    (day) => day.activities || []
  );
  const filtered = allActivities.filter((a) => a.workingState === key);
  const totalMinutes = filtered.reduce(
    (sum, a) => sum + getMinutesFromDuration(a.duration),
    0
  );
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h${m.toString().padStart(2, "0")}m`;
};

const transformActivityData = (activityData) => {
  if (!activityData?.days || !Array.isArray(activityData.days)) return [];

  // Extract year from weekRange (handles formats like "Jul 1 – Jul 7 2025")
  const yearMatch = activityData.weekRange.match(/\d{4}$/);
  const year = yearMatch ? yearMatch[0] : dayjs().year();

  return activityData.days.map((day) => {
    const apiCommitment = day?.commitment || "0h00";

    let states =
      day.activities?.map((activity) => {
        const startTime = activity.startTime?.split(":") || [0, 0];
        const endTime = activity.endTime?.split(":") || [0, 0];

        const startMinutes =
          parseInt(startTime[0]) * 60 + parseInt(startTime[1]);
        const endMinutes = parseInt(endTime[0]) * 60 + parseInt(endTime[1]);

        let stateKey;
        switch (true) {
          case activity.stateType === "DRIVE_NORMAL":
            stateKey = "DRIVING";
            break;
          case activity.stateType?.includes("WARNING"):
            stateKey = "DRIVING_WARNING";
            break;
          case activity.stateType?.includes("VIOLATION"):
            stateKey = "DRIVING_VIOLATION";
            break;
          case activity.workingState === "NOT_AVAILABLE":
            stateKey = "NOT_AVAILABLE";
            break;
          case activity.workingState === "BREAK":
            stateKey = "BREAK";
            break;
          case activity.workingState === "REST" ||
            activity.stateType === "DAILY_REDUCED_REST" ||
            activity.stateType === "BREAK_PARTIAL_15MIN" ||
            activity.stateType === "CONTINUOUS_BREAK_45_MIN":
            stateKey = "REST";
            break;
          case activity.workingState === "AVAILABLE":
            stateKey = "AVAILABLE";
            break;
          default:
            stateKey = "WORK";
        }

        return {
          start: startMinutes,
          end: endMinutes,
          state: stateKey,
          duration: endMinutes - startMinutes,
        };
      }) || [];

    states.sort((a, b) => a.start - b.start);

    const fullDayStart = 0;
    const fullDayEnd = 1440;
    const filledStates = [];
    let lastEnd = fullDayStart;

    for (const s of states) {
      if (s.start > lastEnd) {
        filledStates.push({
          start: lastEnd,
          end: s.start,
          state: "NOT_AVAILABLE",
          duration: s.start - lastEnd,
        });
      }
      filledStates.push(s);
      lastEnd = s.end;
    }

    if (lastEnd < fullDayEnd) {
      filledStates.push({
        start: lastEnd,
        end: fullDayEnd,
        state: "NOT_AVAILABLE",
        duration: fullDayEnd - lastEnd,
      });
    }

    const dateStr = `${day.dateAndMonth} ${year}`;
    const dateObj = dayjs(dateStr, "MMM D YYYY");

    return {
      date: dateObj.format("YYYY-MM-DD"),
      dateObj,
      commitment: apiCommitment,
      drivingTime: calculateDrivingTime(filledStates),
      states: filledStates,
      isEmpty: filledStates.length === 0,
    };
  });
};

const DDDFile = ({
  driverId: propDriverId,
  fromVehicleView,
  apiActivitiesData,
}) => {
  const [driverId, setDriverId] = useState(propDriverId || "");
  const [dateRange, setDateRange] = useState([
    {
      startDate: dayjs().subtract(6, "days").toDate(),
      endDate: dayjs().toDate(),
      key: "selection",
    },
  ]);
  const location = useLocation();
  const driverState = location?.state?.driverState;
  const [activitiesData, setActivitiesData] = useState([]);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalContent, setModalContent] = useState({ title: "", content: "" });

  const SELECTED_CLIENT_ID = "17";

  const { data: driverLookupData, isLoading: isDriversLoading } =
    useQueryGetDriverLookup({
      customerIds: SELECTED_CLIENT_ID,
    });

  useEffect(() => {
    if (driverState) {
      const singleDriverByState = driverLookupData?.response?.find(
        (item) => item?.name === driverState
      );
      setDriverId(
        singleDriverByState?.id ? String(singleDriverByState.id) : ""
      );
    } else if (driverLookupData?.response?.length) {
      setDriverId(String(driverLookupData.response[0].id));
    }
  }, [driverLookupData, driverState]);

  const fromDate =
    dayjs(dateRange[0].startDate).format("YYYY-MM-DD") + "T00:00:00";
  const toDate = dayjs(dateRange[0].endDate).format("YYYY-MM-DD") + "T23:59:59";

  const { data: tachoDriverActivityData } = useQueryGetTachoDriverActivity(
    { driverId, from: fromDate, to: toDate },
    !!driverId && !!SELECTED_CLIENT_ID
  );

  useEffect(() => {
    const responseData = apiActivitiesData || tachoDriverActivityData?.response;
    if (responseData) {
      setActivitiesData(transformActivityData(responseData));
    }
  }, [apiActivitiesData, tachoDriverActivityData]);

  const handleReset = () => {
    setDateRange([
      {
        startDate: dayjs().subtract(6, "days").toDate(),
        endDate: dayjs().toDate(),
        key: "selection",
      },
    ]);
    setError("Reset to last 7 days");
  };

  const handleCloseModal = () => setModalOpen(false);
  const handleCloseSnackbar = () => setError(null);

  const chartSeries = [
    {
      data: activitiesData.flatMap((day) =>
        day.states.map((activity) => {
          // Add gap before end of each state bar for visual purposes only (2 minutes gap)
          const gapMinutes = 2;
          const visualEndTime = Math.max(activity.start + 1, activity.end - gapMinutes);
          
          return {
            x: day.dateObj.format("ddd, MMM D"),
            y: [activity.start / 60, visualEndTime / 60],
            fillColor: DRIVER_STATES[activity.state]?.color,
            state: DRIVER_STATES[activity.state]?.name,
            startTime: activity.start,
            endTime: activity.end, // Keep original end time for tooltip
          };
        })
      ),
    },
  ];

  const chartOptions = {
    chart: {
      type: "rangeBar",
      height: 420,
      toolbar: { show: false },
      zoom: { enabled: false },
      selection: { enabled: false },
    },
    plotOptions: {
      bar: {
        horizontal: true,
        barHeight: "80%",
        rangeBarGroupRows: true,
      },
    },
    xaxis: {
      min: 0,
      max: 24,
      tickAmount: 24,
      labels: {
        formatter: (val) => `${val}h`,
      },
    },
    grid: {
      borderColor: "#ff0000",
      strokeDashArray: 0,
      yaxis: {
        lines: {
          show: true,
        },
      },
    },
    tooltip: {
      custom: ({ dataPointIndex, w }) => {
        const d = w.globals.initialSeries[0].data[dataPointIndex];
        // Use original startTime and endTime for tooltip (not the visually shortened ones)
        const startHours = Math.floor(d.startTime / 60);
        const startMinutes = d.startTime % 60;
        const endHours = Math.floor(d.endTime / 60);
        const endMinutes = d.endTime % 60;
        
        const start = `${startHours}:${String(startMinutes).padStart(2, "0")}`;
        const end = `${endHours}:${String(endMinutes).padStart(2, "0")}`;
        
        return `
        <div class="custom-tooltip" style="padding:5px;">
        <strong>${d.state}</strong><br/>
        ${start} - ${end}
        </div>`;
      },
    },
  };

  const barHeightPx = (390 * 0.8) / (activitiesData.length || 7);

  const activityData = tachoDriverActivityData?.response;

  const filteredDataLegend = Array.from(
    new Set(
      activityData?.days?.flatMap(
        (day) =>
          day?.activities?.map((activity) => activity?.workingState) || []
      )
    )
  ).filter((state) => DRIVER_STATES[state]);

  console.log(driverId, "driverId");
  console.log(driverLookupData, "driverLookupData");

  return (
    <Card sx={{ pt: 6, pb: 3, px: 3 }}>
      {/* Header Row */}
      <Grid container justifyContent="space-between" alignItems="center" mb={1}>
        <Grid item display="flex" alignItems="center" gap={1}>
          {fromVehicleView && (
            <Button
              startIcon={<ArrowBack />}
              variant="outlined"
              onClick={() => window.history.back()}
            >
              Back
            </Button>
          )}
          <Typography
            variant="h5"
            component="div"
            sx={{ ml: fromVehicleView ? 1 : 0 }}
          >
            Driver Activities
          </Typography>
        </Grid>
        <Grid item>
          <Button
            startIcon={<Refresh />}
            variant="outlined"
            onClick={handleReset}
          >
            Reset
          </Button>
        </Grid>
      </Grid>
      {/* Driver select and date range picker */}
      <Grid container spacing={2} mb={3}>
        {!propDriverId && (
          <Grid item xs={12} md={6}>
            <Select
              fullWidth
              displayEmpty
              value={driverId}
              onChange={(e) => setDriverId(String(e.target.value))}
              disabled={isDriversLoading}
              renderValue={(selected) => {
                if (!selected) return "Select Driver";
                const d = driverLookupData?.response?.find(
                  (dr) => String(dr.id) === selected
                );
                return d ? `${d.name}` : "Select Driver";
              }}
            >
              {isDriversLoading && (
                <MenuItem value="" disabled>
                  <CircularProgress size={20} />
                </MenuItem>
              )}
              {driverLookupData?.response?.map((driver) => (
                <MenuItem key={driver.id} value={String(driver.id)}>
                  {driver.name}
                </MenuItem>
              ))}
            </Select>
          </Grid>
        )}

        <Grid item xs={12} md={propDriverId ? 12 : 6}>
          <CustomDateRangePicker
            setDateOption={({ fromDate, toDate }) => {
              setDateRange([
                {
                  startDate: new Date(fromDate),
                  endDate: new Date(toDate),
                  key: "selection",
                },
              ]);
            }}
            findBtnClicked={() => {
              // This will trigger the data refetch through the existing useEffect
            }}
            maxDays={7}
            disablePredefinedRanges={false}
            minDate={dayjs().subtract(365, "day").toDate()}
            maxDate={dayjs().toDate()}
          />
        </Grid>
      </Grid>
      {/* Selected driver & date range title */}
      <Box mb={0}>
        <Typography variant="h5">
          {driverId
            ? `${
                driverLookupData?.response?.find(
                  (d) => String(d.id) === String(driverId)
                )?.name
              } ${
                driverLookupData?.response?.find(
                  (d) => String(d.id) === String(driverId)
                )?.surname
              }`
            : "Select a driver"}{" "}
          {dayjs(dateRange[0]?.startDate).format("MMM D")} -{" "}
          {dayjs(dateRange[0]?.endDate).format("MMM D, YYYY")}
        </Typography>
      </Box>
      {/* Main chart and data summaries */}
      <Box display="flex" gap={2} overflow="none">
        <Box flex={1} minWidth={700}>
          <ReactApexChart
            options={chartOptions}
            series={chartSeries}
            type="rangeBar"
            height={420}
          />
        </Box>
        <Box minWidth={150} mt={4}>
          {activitiesData.map((day, idx) => (
            <Box key={idx} height={barHeightPx} mb={1}>
              <Grid container justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  Commitment:
                </Typography>
                <Typography variant="body2">{day.commitment}</Typography>
              </Grid>
              <Grid container justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  Driving:
                </Typography>
                <Typography variant="body2">{day.drivingTime}</Typography>
              </Grid>
            </Box>
          ))}
        </Box>
      </Box>
      {/* Legend */}
      {activityData?.days && filteredDataLegend.length > 0 && (
        <Box mt={4}>
          <Typography variant="h6" gutterBottom>
            Legend
          </Typography>
          <Grid container spacing={2}>
            {filteredDataLegend.map((state) => (
              <Grid
                key={state}
                item
                xs="auto"
                display="flex"
                alignItems="center"
                gap={1}
              >
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    borderRadius: 1,
                    bgcolor: DRIVER_STATES[state]?.color,
                  }}
                />
                <Typography variant="body2">
                  {DRIVER_STATES[state]?.name}
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ ml: 1 }}
                >
                  {getTotalDurationByState(state, activityData)}
                </Typography>
              </Grid>
            ))}
          </Grid>
        </Box>
      )}
      {/* Snackbar for reset message */}
      <Snackbar
        open={!!error}
        autoHideDuration={4000}
        message={error}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      />
      {/* Modal for error messages */}
      <Dialog
        open={modalOpen}
        onClose={handleCloseModal}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{modalContent.title}</DialogTitle>
        <DialogContent>
          <Typography>{modalContent.content}</Typography>
          <Box mt={2} display="flex" justifyContent="flex-end">
            <Button onClick={handleCloseModal} variant="contained">
              OK
            </Button>
          </Box>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default DDDFile;