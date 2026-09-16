'use client';

import { useEffect, useState } from 'react';

interface Stats {
  globalAccuracy: string;
  recentAccuracy: string;
  shrunkenAccuracy: string;
  mae: string;
  totalMatched: number;
}

export default function BacktestingPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/calibrate', { method: 'POST' });
        const data = await res.json();

        if (data.stats) {
          setStats(data.stats);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  if (loading) return <div className="p-8">Loading...</div>;
  if (error) return <div className="p-8 text-red-600">Error: {error}</div>;
  if (!stats) return <div className="p-8">No data yet</div>;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold mb-2">Backtesting Dashboard</h1>
        <p className="text-gray-600 mb-8">Serie A Prediction Model Analysis</p>

        {/* Metriche principali */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-600 mb-2">Global Accuracy</p>
            <p className="text-3xl font-bold text-blue-600">{stats.globalAccuracy}</p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-600 mb-2">Recent (Last 10)</p>
            <p className="text-3xl font-bold text-green-600">{stats.recentAccuracy}</p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-600 mb-2">Shrunk Accuracy</p>
            <p className="text-3xl font-bold text-purple-600">{stats.shrunkenAccuracy}</p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-600 mb-2">MAE (Goals)</p>
            <p className="text-3xl font-bold text-orange-600">{stats.mae}</p>
          </div>
        </div>

        {/* Dettagli */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-bold mb-4">Model Performance</h2>
          
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-700">Total Predictions Tracked:</span>
              <span className="font-semibold">{stats.totalMatched}</span>
            </div>
            
            <div className="flex justify-between border-t pt-3">
              <span className="text-gray-700">Global Accuracy (All time):</span>
              <span className="font-semibold">{stats.globalAccuracy}</span>
            </div>
            
            <div className="flex justify-between">
              <span className="text-gray-700">Recent Form (Last 10):</span>
              <span className="font-semibold">{stats.recentAccuracy}</span>
            </div>
            
            <div className="flex justify-between border-t pt-3">
              <span className="text-gray-700">Calibrated Accuracy (70% global + 30% recent):</span>
              <span className="font-semibold text-purple-600">{stats.shrunkenAccuracy}</span>
            </div>
            
            <div className="flex justify-between border-t pt-3">
              <span className="text-gray-700">Mean Absolute Error (Goals):</span>
              <span className="font-semibold">{stats.mae}</span>
            </div>
          </div>

          <p className="text-sm text-gray-500 mt-6">
            💡 <strong>Shrinkage Weight:</strong> 30% recency + 70% historical. 
            This prevents overfitting to recent lucky runs.
          </p>
        </div>
      </div>
    </div>
  );
}