#include "utils.hpp"
#include "../src/Bitset.hpp"

namespace result
{
    constexpr int wrong_count = 1;
    constexpr int wrong_indices = 2;
    constexpr int not_empty = 3;
};

int test_full_bitset(int n = 10000)
{
    Bitset bitset(n, Bitset::AllSet);
    if (bitset.count() != n)
        return result::wrong_count;
    int c{};
    for (auto i : bitset)
    {
        //std::cout << i << ",";
        //if(c % 100 == 0)
        //    std::cout << std::endl;
        if (i != c++)
            return result::wrong_indices;
    }
    return result::success;
}

int test_even_bitset(int n = 10000)
{
    Bitset bitset;
    for (auto i : i_range(n))
        bitset.set(i * 2);
    if (bitset.count() != n)
        return result::wrong_count;
    for (auto i : i_range(n))
        if (!bitset.test(2 * i))
            return result::wrong_indices;
    return result::success;
}

int test_empty_bitset()
{
    Bitset bitset;
    for (auto i: bitset)
        return result::not_empty;
    return result::success;
}

int main()
{
    check_res(test_full_bitset());
    check_res(test_even_bitset());
    check_res(test_empty_bitset());
    return result::success;
}