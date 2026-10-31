static int Add(int left, int right) => left + right;

if (Add(20, 22) != 42)
{
    throw new InvalidOperationException(".NET fixture failed");
}

Console.WriteLine(".NET fixture passed");
