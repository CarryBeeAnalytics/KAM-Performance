import { useEffect, useRef } from "react";
import * as echarts from "echarts";

/**
 * Thin ECharts wrapper. ECharts is the CarryBee dashboard standard, so the
 * Business Insights charts look and behave the same as the Top Merchant
 * dashboard they replace.
 */
export default function EChart({ option, height = 320 }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!boxRef.current) return undefined;
    chartRef.current = echarts.init(boxRef.current);
    const onResize = () => chartRef.current && chartRef.current.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chartRef.current && chartRef.current.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (chartRef.current && option) chartRef.current.setOption(option, true);
  }, [option]);

  return <div ref={boxRef} style={{ width: "100%", height }} />;
}
